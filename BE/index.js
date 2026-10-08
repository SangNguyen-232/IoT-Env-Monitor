const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const BCRYPT_ROUNDS = 10;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required. Copy .env.example to .env and set it.`);
    process.exit(1);
  }
  return value;
}

const sessionSecret = process.env.SESSION_SECRET || (
  process.env.NODE_ENV === 'production'
    ? requireEnv('SESSION_SECRET')
    : crypto.randomBytes(32).toString('hex')
);

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is missing; using an ephemeral secret (sessions reset on restart).');
}

if (!process.env.DB_PASS) {
  console.error('DB_PASS is required.');
  process.exit(1);
}

const sensorApiKey = process.env.SENSOR_API_KEY;
if (!sensorApiKey) {
  console.error('SENSOR_API_KEY is required.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  database: process.env.DB_NAME     || 'iot_db',
  user:     process.env.DB_USER     || 'iot_user',
  password: process.env.DB_PASS,
  port:     parseInt(process.env.DB_PORT || '5432', 10),
});

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$/.test(value);
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, stored) {
  if (!stored || !plain) return { ok: false, rehash: false };
  if (isBcryptHash(stored)) {
    return { ok: await bcrypt.compare(plain, stored), rehash: false };
  }
  if (plain === stored) {
    return { ok: true, rehash: true };
  }
  return { ok: false, rehash: false };
}

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function loginBlocked(req) {
  const rec = loginAttempts.get(clientIp(req));
  return Boolean(rec && rec.resetAt >= Date.now() && rec.count >= LOGIN_MAX_ATTEMPTS);
}

function recordLoginFailure(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    rec = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  }
  rec.count += 1;
  loginAttempts.set(ip, rec);
}

function clearLoginFailures(req) {
  loginAttempts.delete(clientIp(req));
}

function rateLimitLogin(req, res, next) {
  if (loginBlocked(req)) {
    return res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng thử lại sau.' });
  }
  next();
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  const path = (req.originalUrl || req.path || '').split('?')[0];
  if (path.includes('/admin/api')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: 'Chỉ Admin mới có quyền thực hiện thao tác này.' });
}

function requireSensorKey(req, res, next) {
  const provided = req.get('X-Device-Key') || '';
  if (!safeEqual(provided, sensorApiKey)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function sanitizeDeviceId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim().slice(0, 64);
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
}

function sanitizeLanIp(ip) {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return null;
  return trimmed;
}

async function seedAdminIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM system_users');
  if (rows[0].n > 0) return;
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn('system_users is empty. Set ADMIN_USERNAME and ADMIN_PASSWORD to create the first admin.');
    return;
  }
  await pool.query(
    'INSERT INTO system_users (username, password, role) VALUES ($1, $2, $3)',
    [username.trim(), await hashPassword(password), 'admin']
  );
  console.log(`Seeded admin user "${username.trim()}".`);
}

async function ensureSchema() {
  await pool.query(`ALTER TABLE sensor_logs ADD COLUMN IF NOT EXISTS received_at timestamptz DEFAULT NOW()`);
  await pool.query(`ALTER TABLE sensor_logs ADD COLUMN IF NOT EXISTS lan_ip text`);
}

ensureSchema()
  .then(() => seedAdminIfEmpty())
  .catch((err) => {
    console.error('Failed to initialize schema/admin:', err);
  });

app.use('/login-static', express.static(path.join(__dirname, 'login_static')));

app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/admin/admin.html');
  res.sendFile(path.join(__dirname, 'login_static', 'login.html'));
});

app.post('/login', rateLimitLogin, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin.' });
    }

    const result = await pool.query(
      'SELECT id, username, role, password FROM system_users WHERE username = $1',
      [username.trim()]
    );

    if (result.rows.length === 0) {
      recordLoginFailure(req);
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
    }

    const user = result.rows[0];
    const check = await verifyPassword(password, user.password);
    if (!check.ok) {
      recordLoginFailure(req);
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
    }

    clearLoginFailures(req);

    if (check.rehash) {
      await pool.query('UPDATE system_users SET password = $1 WHERE id = $2', [
        await hashPassword(password),
        user.id
      ]);
    }

    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ ok: true, role: user.role, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Tài khoản hoặc mật khẩu không đúng.' });
  }
});

app.post('/register', (req, res) => {
  res.status(403).json({ error: 'Đăng ký công khai đã tắt. Liên hệ quản trị viên để được cấp tài khoản.' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ loggedIn: true, username: req.session.user.username, role: req.session.user.role });
  } else {
    res.json({ loggedIn: false });
  }
});

app.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/admin/admin.html');
  res.redirect('/login');
});

app.use('/admin', requireLogin, express.static(path.join(__dirname, 'admin_static'), { index: 'admin.html' }));

app.post('/sensor', requireSensorKey, async (req, res) => {
  try {
    const {
      timestamp_real, timestamp_up, temperature, humidity,
      soil_moisture, PUMP_state, MODE_state, Message, Score,
      device_id, lan_ip, latency, trigger_source
    } = req.body;

    const safeDeviceId = sanitizeDeviceId(device_id);
    if (!safeDeviceId) {
      return res.status(400).json({ error: 'invalid device_id' });
    }

    const safeMessage = typeof Message === 'string' ? Message.slice(0, 120) : Message;
    const safeLanIp = sanitizeLanIp(lan_ip);

    await pool.query(
      `INSERT INTO sensor_logs
        (timestamp_real, timestamp_up, received_at, temperature, humidity,
         soil_moisture, "PUMP_state", "MODE_state", "Message", "Score", device_id, lan_ip, latency, trigger_source)
       VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        timestamp_real === 'null' ? null : timestamp_real,
        timestamp_up, temperature, humidity, soil_moisture,
        PUMP_state, MODE_state, safeMessage, Score,
        safeDeviceId,
        safeLanIp,
        latency !== undefined ? latency : null,
        trigger_source || 'sensor'
      ]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.get('/admin/api/devices', requireLogin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (device_id)
        device_id, lan_ip, temperature, humidity, soil_moisture,
        "PUMP_state", "MODE_state", "Message", "Score",
        timestamp_real AT TIME ZONE 'Asia/Ho_Chi_Minh' AS timestamp_real,
        timestamp_up AT TIME ZONE 'Asia/Ho_Chi_Minh' AS timestamp_up,
        COALESCE(received_at, timestamp_up AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh' AS received_at
      FROM sensor_logs
      ORDER BY device_id, COALESCE(received_at, timestamp_up AT TIME ZONE 'Asia/Ho_Chi_Minh') DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/devices/:device_id/history', requireLogin, async (req, res) => {
  try {
    const { device_id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 60, 200);
    const result = await pool.query(`
      SELECT temperature, humidity, soil_moisture,
             "PUMP_state", "MODE_state", "Message", "Score",
             timestamp_real AT TIME ZONE 'Asia/Ho_Chi_Minh' AS timestamp_real,
             timestamp_up AT TIME ZONE 'Asia/Ho_Chi_Minh' AS timestamp_up
      FROM sensor_logs
      WHERE device_id = $1
      ORDER BY timestamp_up DESC
      LIMIT $2
    `, [device_id, limit]);
    res.json(result.rows.reverse());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/api/devices/:device_id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { device_id } = req.params;
    await pool.query('DELETE FROM sensor_logs WHERE device_id = $1', [device_id]);
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/devices/:device_id/verify', requireLogin, rateLimitLogin, async (req, res) => {
  try {
    const { device_id } = req.params;
    const { password } = req.body;
    const result = await pool.query(
      'SELECT password FROM device_credentials WHERE device_id = $1',
      [device_id]
    );
    if (result.rows.length === 0) return res.json({ ok: false, reason: 'no_password' });
    const check = await verifyPassword(password, result.rows[0].password);
    if (!check.ok) {
      recordLoginFailure(req);
      return res.json({ ok: false });
    }
    clearLoginFailures(req);
    if (check.ok && check.rehash) {
      await pool.query(
        'UPDATE device_credentials SET password = $1 WHERE device_id = $2',
        [await hashPassword(password), device_id]
      );
    }
    res.json({ ok: check.ok });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/devices/:device_id/has-password', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { device_id } = req.params;
    const result = await pool.query(
      'SELECT 1 FROM device_credentials WHERE device_id = $1',
      [device_id]
    );
    res.json({ hasPassword: result.rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/devices/:device_id/password', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { device_id } = req.params;
    const { password } = req.body;
    if (!password || password.trim() === '') return res.status(400).json({ error: 'password required' });
    const hashed = await hashPassword(password);
    await pool.query(
      `INSERT INTO device_credentials (device_id, password)
       VALUES ($1, $2)
       ON CONFLICT (device_id) DO UPDATE SET password = EXCLUDED.password`,
      [device_id, hashed]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/api/devices/:device_id/password', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { device_id } = req.params;
    await pool.query('DELETE FROM device_credentials WHERE device_id = $1', [device_id]);
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/users', requireLogin, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, role, created_at FROM system_users ORDER BY created_at ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/users', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Thiếu thông tin hoặc role không hợp lệ.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự.' });
    }
    await pool.query(
      'INSERT INTO system_users (username, password, role) VALUES ($1, $2, $3)',
      [username.trim(), await hashPassword(password), role]
    );
    res.sendStatus(201);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại.' });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.session.user.id) {
      return res.status(400).json({ error: 'Không thể xóa tài khoản đang đăng nhập.' });
    }
    await pool.query('DELETE FROM system_users WHERE id = $1', [id]);
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('API running on port 3000'));
