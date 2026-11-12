const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const { TELEMETRY_FIELDS: SENSOR_TELEMETRY_FIELDS, validExperimentFields, parseHistoryQuery } = require('./telemetry');

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
const tp = process.env.TRUST_PROXY;
if (tp) {
  app.set('trust proxy', tp === 'true' ? true : tp === 'false' ? false : /^\d+$/.test(tp) ? parseInt(tp, 10) : tp);
}
// Disable CSP for inline scripts/styles in admin and login pages.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'invalid request body' });
  }
  next();
});

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  database: process.env.DB_NAME     || 'iot_db',
  user:     process.env.DB_USER     || 'iot_user',
  password: process.env.DB_PASS,
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => console.error('Unexpected PG pool error:', err));

app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

// Resolve the current account so deletion/revocation takes effect for existing sessions.
app.use(async (req, res, next) => {
  if (!req.session.user) return next();
  try {
    const result = await pool.query('SELECT id, username, role FROM system_users WHERE id = $1', [req.session.user.id]);
    if (result.rowCount === 0) {
      return req.session.destroy(err => err ? next(err) : next());
    }
    req.session.user = result.rows[0];
    next();
  } catch (err) {
    next(err);
  }
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
  const routePath = (req.originalUrl || req.path || '').split('?')[0];
  if (routePath.includes('/admin/api')) {
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
  const trimmed = id.trim();
  if (trimmed.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
}

function sanitizeLanIp(ip) {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return null;
  if (trimmed.split('.').some(part => Number(part) > 255)) return null;
  return trimmed;
}

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  if (!v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function userCanAccessDevice(req, deviceId, lanIp) {
  const u = req.session.user;
  if (u.role === 'admin') return true;
  const r = await pool.query(
    `SELECT 1 FROM user_devices
     WHERE user_id = $1 AND device_id = $2
       AND ($3::text IS NULL OR lan_ip = '' OR lan_ip = $3)`,
    [u.id, deviceId, lanIp || null]
  );
  return r.rowCount > 0;
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

const retentionSetting = process.env.SENSOR_RETENTION_DAYS ?? '30';
if (!/^(0|[1-9]\d{0,5})$/.test(retentionSetting)) {
  throw new Error('SENSOR_RETENTION_DAYS must be a whole number from 0 to 999999 (0 disables automatic deletion).');
}
const RETENTION_DAYS = Number(retentionSetting);

async function purgeOldLogs() {
  if (!(RETENTION_DAYS > 0)) return;
  try {
    const r = await pool.query(
      `DELETE FROM sensor_logs WHERE COALESCE(received_at, timestamp_up) < NOW() - make_interval(days => $1::int)`,
      [RETENTION_DAYS]
    );
    if (r.rowCount) console.log(`Purged ${r.rowCount} sensor_logs older than ${RETENTION_DAYS} days.`);
  } catch (err) {
    console.error('purgeOldLogs failed:', err);
  }
}

async function ensureSchema() {
  const sensorColumns = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sensor_logs'
  `);
  const columnNames = new Set(sensorColumns.rows.map(row => row.column_name));
  const requiredColumns = ['id', 'received_at', ...SENSOR_TELEMETRY_FIELDS];
  if (requiredColumns.some(column => !columnNames.has(column))) {
    throw new Error('sensor_logs is missing required columns. For an existing database, back up data and apply database/migrations/005_ai_telemetry.sql before starting this backend. See database/MIGRATIONS.md. Fresh databases use the Docker Compose schema scripts. Do not delete the database volume.');
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      sid varchar PRIMARY KEY,
      sess json NOT NULL,
      expire timestamp(6) NOT NULL
    );
    ALTER TABLE "session" ADD COLUMN IF NOT EXISTS login_at timestamptz;
    ALTER TABLE "session" ALTER COLUMN login_at SET DEFAULT CURRENT_TIMESTAMP;
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" (expire);
  `);
}

app.get('/healthz', async (req, res) => {
  try {
    await pool.query({ text: 'SELECT 1', query_timeout: 2000 });
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/admin/admin.html');
  res.sendFile(path.join(__dirname, '../public/login', 'login.html'));
});

app.post('/login', rateLimitLogin, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
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

    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.user = { id: user.id, username: user.username, role: user.role };
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    res.json({ ok: true, role: user.role, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Tài khoản hoặc mật khẩu không đúng.' });
  }
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

app.use('/admin', requireLogin, express.static(path.join(__dirname, '../public/admin'), { index: 'admin.html' }));

app.post('/sensor', requireSensorKey, async (req, res) => {
  try {
    if (Object.keys(req.body).some(field => !SENSOR_TELEMETRY_FIELDS.has(field))) {
      return res.status(400).json({ error: 'unsupported telemetry fields' });
    }
    const {
      timestamp_real, timestamp_up, temperature, humidity,
      soil_moisture, FAN_state, MODE_state, Message, Score,
      device_id, lan_ip, latency, trigger_source,
      boot_id, sample_seq, sampled_uptime_ms, ai, fan_reason, fan_config,
      fan_decision_sample_seq, fan_decided_uptime_ms
    } = req.body;

    const safeDeviceId = sanitizeDeviceId(device_id);
    if (!safeDeviceId) {
      return res.status(400).json({ error: 'invalid device_id' });
    }

    const safeMessage = typeof Message === 'string' ? Message.slice(0, 120) : Message;
    const safeLanIp = sanitizeLanIp(lan_ip);
    const sensorNumber = (value, unit) => {
      if (value === '--') return null;
      if (typeof value === 'string' && value.endsWith(unit)) value = value.slice(0, -unit.length);
      return toNum(value);
    };
    const tempValue = sensorNumber(temperature, '°C');
    const humidityValue = sensorNumber(humidity, '%');
    const soilValue = sensorNumber(soil_moisture, '%');
    const optionalNumberValid = (raw, parsed, min, max) => raw == null || raw === '--' ||
      (parsed !== null && parsed >= min && parsed <= max);
    const timestampValid = value => typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value) && Number.isFinite(Date.parse(value));
    if (!timestampValid(timestamp_up) ||
        (timestamp_real != null && timestamp_real !== 'null' && !timestampValid(timestamp_real)) ||
        (lan_ip != null && lan_ip !== '' && !safeLanIp) ||
        !optionalNumberValid(temperature, tempValue, -40, 125) ||
        !optionalNumberValid(humidity, humidityValue, -1, 100) ||
        !optionalNumberValid(soil_moisture, soilValue, 0, 100) ||
        (latency != null && (!Number.isInteger(latency) || latency < 0 || latency > 2147483647)) ||
        (FAN_state != null && !['ON', 'OFF'].includes(FAN_state)) ||
        (MODE_state != null && !['AUTO', 'SHADOW', 'AI', 'MANUAL'].includes(MODE_state)) ||
        (Message != null && typeof Message !== 'string') ||
        (Score != null && !['number', 'string'].includes(typeof Score)) ||
        (typeof Score === 'number' && !Number.isFinite(Score)) ||
        (typeof Score === 'string' && Score.length > 120) ||
        (trigger_source != null && !['sensor', 'fan', 'ai'].includes(trigger_source)) ||
        !validExperimentFields(req.body)) {
      return res.status(400).json({ error: 'invalid telemetry' });
    }

    await pool.query(
      `INSERT INTO sensor_logs
        (timestamp_real, timestamp_up, received_at, temperature, humidity,
         soil_moisture, "FAN_state", "MODE_state", "Message", "Score", device_id, lan_ip, latency, trigger_source,
         boot_id, sample_seq, sampled_uptime_ms, ai, fan_reason, fan_config,
         fan_decision_sample_seq, fan_decided_uptime_ms)
       VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19::jsonb,$20,$21)`,
      [
        timestamp_real === 'null' ? null : timestamp_real,
        timestamp_up, tempValue, humidityValue === -1 ? null : humidityValue, soilValue,
        FAN_state, MODE_state, safeMessage, Score,
        safeDeviceId,
        safeLanIp,
        latency !== undefined ? latency : null,
        trigger_source || 'sensor',
        boot_id ?? null, sample_seq ?? null, sampled_uptime_ms ?? null,
        ai == null ? null : JSON.stringify(ai), fan_reason ?? null,
        fan_config == null ? null : JSON.stringify(fan_config),
        fan_decision_sample_seq ?? null, fan_decided_uptime_ms ?? null
      ]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    if (err.code && err.code.startsWith('22')) return res.status(400).json({ error: 'invalid telemetry' });
    res.sendStatus(500);
  }
});

app.get('/admin/api/devices', requireLogin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (s.device_id, COALESCE(s.lan_ip, ''))
          s.device_id, s.lan_ip,
          (s.device_id || CASE WHEN s.lan_ip IS NOT NULL AND s.lan_ip <> '' THEN '_' || s.lan_ip ELSE '' END) AS card_key,
          s.temperature, s.humidity, s.soil_moisture,
          s."FAN_state", s."MODE_state", s."Message", s."Score",
          s.boot_id, s.sample_seq::float8 AS sample_seq, s.sampled_uptime_ms::float8 AS sampled_uptime_ms,
          s.ai, s.fan_reason, s.fan_config,
          s.fan_decision_sample_seq::float8 AS fan_decision_sample_seq,
          s.fan_decided_uptime_ms::float8 AS fan_decided_uptime_ms,
          s.timestamp_real AS timestamp_real,
          s.timestamp_up   AS timestamp_up,
          COALESCE(s.received_at, s.timestamp_up) AS received_at,
          EXTRACT(EPOCH FROM (NOW() - COALESCE(s.received_at, s.timestamp_up)))::float8 AS age_seconds
        FROM sensor_logs s
        WHERE s.device_id IS NOT NULL
          AND ($1::boolean OR EXISTS (
                SELECT 1 FROM user_devices ud
                WHERE ud.user_id = $2 AND ud.device_id = s.device_id
                  AND (ud.lan_ip = '' OR ud.lan_ip = COALESCE(s.lan_ip, ''))))
        ORDER BY s.device_id, COALESCE(s.lan_ip, ''), COALESCE(s.received_at, s.timestamp_up) DESC, s.id DESC
      ) sub
      ORDER BY sub.device_id, sub.received_at DESC
    `, [req.session.user.role === 'admin', req.session.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Export bounded, ordered pages. The high-water ID excludes later normal inserts;
// retention/deletion and transactions committed late can still change visibility.
// This is deliberately not advertised as an immutable database snapshot.
app.get('/admin/api/history', requireLogin, async (req, res) => {
  const query = parseHistoryQuery(req.query);
  if (!query) return res.status(400).json({ error: 'invalid history query' });
  try {
    if (!(await userCanAccessDevice(req, query.deviceId, query.lanIp))) {
      return res.status(403).json({ error: 'Không có quyền truy cập thiết bị này.' });
    }
    const result = await pool.query({
      text: `WITH boundary AS (
        SELECT COALESCE($7::integer, (SELECT MAX(s.id) FROM sensor_logs s
        WHERE s.device_id = $1 AND ($2::text IS NULL OR s.lan_ip = $2)
          AND ($3::timestamptz IS NULL OR COALESCE(s.received_at, s.timestamp_up) >= $3)
          AND ($4::timestamptz IS NULL OR COALESCE(s.received_at, s.timestamp_up) < $4)
          AND ($5::boolean OR EXISTS (
            SELECT 1 FROM user_devices ud WHERE ud.user_id = $6 AND ud.device_id = s.device_id
              AND (ud.lan_ip = '' OR ud.lan_ip = COALESCE(s.lan_ip, ''))))), 0) AS until_id
      ), page AS (
        SELECT s.* FROM sensor_logs s CROSS JOIN boundary b
        WHERE s.device_id = $1 AND ($2::text IS NULL OR s.lan_ip = $2)
          AND ($3::timestamptz IS NULL OR COALESCE(s.received_at, s.timestamp_up) >= $3)
          AND ($4::timestamptz IS NULL OR COALESCE(s.received_at, s.timestamp_up) < $4)
          AND ($5::boolean OR EXISTS (
            SELECT 1 FROM user_devices ud WHERE ud.user_id = $6 AND ud.device_id = s.device_id
              AND (ud.lan_ip = '' OR ud.lan_ip = COALESCE(s.lan_ip, ''))))
          AND s.id > $8 AND s.id <= b.until_id
        ORDER BY s.id ASC LIMIT $9
      ) SELECT boundary.until_id,
        COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id) FROM page), '[]'::jsonb) AS rows
      FROM boundary`,
      values: [query.deviceId, query.lanIp, query.from, query.to,
        req.session.user.role === 'admin', req.session.user.id,
        query.untilId ?? null, query.afterId, query.limit + 1],
      query_timeout: 10000
    });
    const { until_id: untilId, rows } = result.rows[0];
    const hasMore = rows.length > query.limit;
    if (hasMore) rows.pop();
    res.set('Cache-Control', 'no-store');
    res.json({ rows, next_after_id: hasMore ? rows[rows.length - 1].id : null, until_id: untilId });
  } catch (err) {
    console.error('History export failed:', err);
    res.status(500).json({ error: 'history export failed' });
  }
});

app.delete('/admin/api/devices/:device_id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { device_id } = req.params;
    const { lan_ip } = req.query;
    if (lan_ip) {
      await pool.query('DELETE FROM sensor_logs WHERE device_id = $1 AND lan_ip = $2', [device_id, lan_ip]);
    } else {
      await pool.query('DELETE FROM sensor_logs WHERE device_id = $1', [device_id]);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Device tickets: the backend signs HMAC tickets; ESP32 verifies them. ---
const TICKET_TTL_MS = 5 * 60 * 1000; // 5 minutes

function makeDeviceTicket(deviceId, lanIp) {
  const expiresAt = Date.now() + TICKET_TTL_MS;
  const payload = `${deviceId}:${lanIp}:${expiresAt}`;
  const sig = crypto.createHmac('sha256', sensorApiKey).update(payload).digest('hex');
  const raw = Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
  return { ticket: raw, expiresAt };
}

app.post('/admin/api/devices/:device_id/ticket', requireLogin, rateLimitLogin, async (req, res) => {
  try {
    const { device_id } = req.params;
    let lanIp = req.body.lan_ip == null ? '' : sanitizeLanIp(req.body.lan_ip);
    if (lanIp === null) return res.status(400).json({ error: 'invalid lan_ip' });
    if (!lanIp) {
      const ipRow = await pool.query(
        'SELECT lan_ip FROM sensor_logs WHERE device_id = $1 AND lan_ip IS NOT NULL ORDER BY received_at DESC LIMIT 1',
        [device_id]
      );
      lanIp = (ipRow.rows[0] && ipRow.rows[0].lan_ip) || '';
    }
    if (!(await userCanAccessDevice(req, device_id, lanIp))) {
      return res.status(403).json({ error: 'Không có quyền truy cập thiết bị này.' });
    }
    const { password } = req.body;
    const credResult = await pool.query(
      'SELECT password FROM device_credentials WHERE device_id = $1',
      [device_id]
    );
    if (credResult.rows.length === 0) return res.json({ ok: false, reason: 'no_password' });
    if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'password required' });
    const check = await verifyPassword(password, credResult.rows[0].password);
    if (!check.ok) {
      recordLoginFailure(req);
      return res.json({ ok: false });
    }
    clearLoginFailures(req);
    if (check.rehash) {
      await pool.query(
        'UPDATE device_credentials SET password = $1 WHERE device_id = $2',
        [await hashPassword(password), device_id]
      );
    }
    const { ticket, expiresAt } = makeDeviceTicket(device_id, lanIp);
    res.json({ ok: true, ticket, expiresAt, lanIp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- In-memory access requests for devices without a backend password ---
const ACCESS_REQ_PENDING_TTL_MS = 5 * 60 * 1000;
const ACCESS_REQ_DECIDED_TTL_MS = 2 * 60 * 1000;
const accessRequests = new Map();

function pruneAccessRequests() {
  const now = Date.now();
  for (const [id, r] of accessRequests) {
    const ttl = r.status === 'pending' ? ACCESS_REQ_PENDING_TTL_MS : ACCESS_REQ_DECIDED_TTL_MS;
    if (now - r.updatedAt > ttl) accessRequests.delete(id);
  }
}

app.post('/admin/api/devices/:device_id/access-request', requireLogin, async (req, res) => {
  try {
    const { device_id } = req.params;
    const u = req.session.user;
    if (u.role === 'admin') {
      return res.status(400).json({ error: 'Admin không cần gửi yêu cầu.' });
    }
    const lanIp = sanitizeLanIp(req.body.lan_ip);
    if (!lanIp) return res.status(400).json({ error: 'invalid lan_ip' });
    if (!(await userCanAccessDevice(req, device_id, lanIp))) {
      return res.status(403).json({ error: 'Không có quyền truy cập thiết bị này.' });
    }
    const has = await pool.query('SELECT 1 FROM device_credentials WHERE device_id = $1', [device_id]);
    if (has.rowCount > 0) {
      return res.status(400).json({ error: 'Thiết bị đã có mật khẩu.' });
    }
    pruneAccessRequests();
    for (const r of accessRequests.values()) {
      if (r.userId === u.id && r.deviceId === device_id && r.lanIp === lanIp && r.status === 'pending') {
        return res.json({ id: r.id, status: r.status });
      }
    }
    const id = crypto.randomBytes(8).toString('hex');
    accessRequests.set(id, {
      id, userId: u.id, username: u.username, deviceId: device_id, lanIp,
      status: 'pending', updatedAt: Date.now()
    });
    res.json({ id, status: 'pending' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/access-requests/:id/status', requireLogin, async (req, res) => {
  pruneAccessRequests();
  const r = accessRequests.get(req.params.id);
  if (!r || r.userId !== req.session.user.id) return res.json({ status: 'expired' });
  if (r.status === 'approved') {
    if (!(await userCanAccessDevice(req, r.deviceId, r.lanIp))) return res.status(403).json({ status: 'denied' });
    if (!r.ticketData) r.ticketData = makeDeviceTicket(r.deviceId, r.lanIp);
    return res.json({ status: r.status, ...r.ticketData, lanIp: r.lanIp });
  }
  res.json({ status: r.status });
});

app.get('/admin/api/access-requests', requireLogin, requireAdmin, (req, res) => {
  pruneAccessRequests();
  res.json(
    [...accessRequests.values()]
      .filter((r) => r.status === 'pending')
      .map((r) => ({ id: r.id, username: r.username, deviceId: r.deviceId, lanIp: r.lanIp }))
  );
});

app.post('/admin/api/access-requests/:id/decision', requireLogin, requireAdmin, (req, res) => {
  pruneAccessRequests();
  const r = accessRequests.get(req.params.id);
  if (!r || r.status !== 'pending') {
    return res.status(404).json({ error: 'Yêu cầu không còn hiệu lực.' });
  }
  r.status = (req.body && req.body.approve === true) ? 'approved' : 'denied';
  r.updatedAt = Date.now();
  res.sendStatus(200);
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
    if (typeof password !== 'string' || !password.trim()) return res.status(400).json({ error: 'password required' });
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
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password || !['admin', 'user'].includes(role)) {
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

app.get('/admin/api/users/:id/devices', requireLogin, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT device_id, lan_ip FROM user_devices WHERE user_id = $1 ORDER BY device_id, lan_ip',
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/admin/api/users/:id/devices', requireLogin, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const list = (req.body || {}).devices;
  if (!Number.isInteger(userId) || userId < 1 || !Array.isArray(list)) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ.' });
  }
  const seen = new Set();
  const ids = [];
  const ips = [];
  for (const d of list) {
    const id = sanitizeDeviceId(d && d.device_id);
    const ip = sanitizeLanIp(d && d.lan_ip);
    if (!id || !ip) return res.status(400).json({ error: 'invalid device grant' });
    if (seen.has(id + '|' + ip)) continue;
    seen.add(id + '|' + ip);
    ids.push(id);
    ips.push(ip);
  }
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const u = await client.query('SELECT 1 FROM system_users WHERE id = $1', [userId]);
    if (u.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    }
    await client.query('DELETE FROM user_devices WHERE user_id = $1', [userId]);
    if (ids.length) {
      await client.query(
        'INSERT INTO user_devices (user_id, device_id, lan_ip) SELECT $1, t.d, t.ip FROM unnest($2::text[], $3::text[]) AS t(d, ip)',
        [userId, ids, ips]
      );
    }
    await client.query('COMMIT');
    res.sendStatus(200);
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (e) {} }
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (client) client.release();
  }
});

const port = Number(process.env.PORT || 3000);
async function start() {
  await ensureSchema();
  await seedAdminIfEmpty();
  await purgeOldLogs();
  setInterval(purgeOldLogs, 6 * 60 * 60 * 1000).unref();
  app.listen(port, () => console.log(`API running on port ${port}`));
}
start().catch(async err => {
  console.error('Failed to initialize schema/admin:', err);
  await pool.end();
  process.exitCode = 1;
});
