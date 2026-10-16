const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { Pool } = require('pg');

// The supplied connection must allow CREATE DATABASE. Each run owns a fresh DB.
const testUrl = process.env.DB_TEST_URL;
test('backend on an isolated PostgreSQL database', { skip: !testUrl, timeout: 30000 }, async (t) => {
  const admin = new Pool({ connectionString: testUrl });
  const database = `iot_test_${process.pid}_${Date.now()}`;
  let db, server;
  t.after(async () => {
    if (server && server.exitCode === null) {
      const stopped = once(server, 'exit');
      server.kill();
      await stopped;
    }
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  const url = new URL(testUrl);
  url.pathname = `/${database}`;
  db = new Pool({ connectionString: url.href });
  for (const filename of ['schema/base.sql', 'migrations/001_auth.sql']) {
    await db.query(await readFile(path.join(__dirname, '../../../database', filename), 'utf8'));
  }
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(port), TRUST_PROXY: 'false',
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: database,
      DB_USER: decodeURIComponent(url.username), DB_PASS: decodeURIComponent(url.password),
      SESSION_SECRET: 'integration-test-session-secret', SENSOR_API_KEY: 'test-sensor-key',
      ADMIN_USERNAME: 'test-admin', ADMIN_PASSWORD: 'test-password', SENSOR_RETENTION_DAYS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    if (logs.includes('API running on port')) break;
    assert(attempt < 100 && server.exitCode === null, logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const request = (route, options) => fetch(base + route, { redirect: 'manual', ...options });
  const jsonRequest = (route, body, headers = {}, method = 'POST') => request(route, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  async function loginAs(username, password) {
    const response = await jsonRequest('/login', { username, password });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  await t.test('anonymous access and login redirect', async () => {
    const r = await request('/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
    assert.deepEqual(await (await request('/api/me')).json(), { loggedIn: false });
    assert.equal((await request('/admin/api/devices')).status, 401);
  });
  await t.test('rejects unauthorized and malformed telemetry', async () => {
    assert.equal((await request('/sensor', { method: 'POST' })).status, 401);
    assert.equal((await request('/sensor', { method: 'POST', headers: {
      'x-device-key': 'test-sensor-key', 'content-type': 'application/json',
    }, body: JSON.stringify({ device_id: '../invalid' }) })).status, 400);
  });
  await t.test('persists telemetry with pg and PostgreSQL 18', async () => {
    const r = await request('/sensor', { method: 'POST', headers: {
      'x-device-key': 'test-sensor-key', 'content-type': 'application/json',
    }, body: JSON.stringify({ device_id: 'test-uno', lan_ip: '192.168.1.10',
      timestamp_up: new Date().toISOString(), temperature: 24, humidity: 65, soil_moisture: 35,
    }) });
    assert.equal(r.status, 200);
    const { rows } = await db.query('SELECT temperature, humidity FROM sensor_logs WHERE device_id=$1', ['test-uno']);
    assert.deepEqual(rows, [{ temperature: 24, humidity: 65 }]);
  });
  await t.test('bcrypt login, PostgreSQL sessions, dashboard and logout', async () => {
    const login = await request('/login', { method: 'POST', headers: {
      'content-type': 'application/x-www-form-urlencoded',
    }, body: 'username=test-admin&password=test-password' });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).ok, true);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { cookie };
    assert.deepEqual(await (await request('/api/me', { headers })).json(), {
      loggedIn: true, username: 'test-admin', role: 'admin',
    });
    assert.equal((await request('/admin/admin.html', { headers })).status, 200);
    const devices = await (await request('/admin/api/devices', { headers })).json();
    assert(devices.some(d => d.device_id === 'test-uno'));
    assert.equal((await request('/logout', { method: 'POST', headers })).status, 200);
    assert.deepEqual(await (await request('/api/me', { headers })).json(), { loggedIn: false });
  });
  await t.test('rejects invalid telemetry without inserting partial or coerced data', async () => {
    const valid = { device_id: 'validation-uno', lan_ip: '192.168.1.10',
      timestamp_up: new Date().toISOString(), temperature: 24, humidity: 65, soil_moisture: 35 };
    for (const invalid of [
      { timestamp_up: 'not-a-date' }, { timestamp_up: null },
      { temperature: '24garbage' }, { humidity: 101 }, { soil_moisture: -1 },
      { lan_ip: '999.168.1.10' }, { device_id: 'x'.repeat(65) }, { latency: -10 },
    ]) {
      const response = await jsonRequest('/sensor', { ...valid, ...invalid }, { 'x-device-key': 'test-sensor-key' });
      assert.equal(response.status, 400, JSON.stringify(invalid));
    }
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM sensor_logs WHERE device_id='validation-uno'")).rows[0].n, 0);
  });
  await t.test('accepts deployed firmware units and stores missing DHT readings as null', async () => {
    for (const missing of [false, true]) {
      const response = await jsonRequest('/sensor', {
        device_id: 'legacy-unit-uno', timestamp_real: 'null', timestamp_up: new Date().toISOString(),
        temperature: missing ? '--' : '24.50°C', humidity: missing ? '--' : '65.00%', soil_moisture: '35%',
        lan_ip: '', latency: null, PUMP_state: 'OFF', MODE_state: 'AUTO', Message: 'Normal', Score: '95.00%',
      }, { 'x-device-key': 'test-sensor-key' });
      assert.equal(response.status, 200);
    }
    assert.deepEqual((await db.query(`SELECT temperature, humidity, soil_moisture FROM sensor_logs
      WHERE device_id='legacy-unit-uno' ORDER BY id`)).rows, [
      { temperature: 24.5, humidity: 65, soil_moisture: 35 },
      { temperature: null, humidity: null, soil_moisture: 35 },
    ]);
  });
  await t.test('validates credentials and history limits instead of returning server errors', async () => {
    assert.equal((await jsonRequest('/login', { username: {}, password: [] })).status, 400);
    assert.equal((await jsonRequest('/login', { username: '   ', password: 'x' })).status, 400);
    const headers = await loginAs('test-admin', 'test-password');
    assert.equal((await jsonRequest('/admin/api/users', { username: {}, password: [], role: 'user' }, headers)).status, 400);
    assert.equal((await jsonRequest('/admin/api/devices/test-uno/password', { password: {} }, headers)).status, 400);
    for (const limit of ['-1', '1.5', 'abc', '0']) {
      assert.equal((await request(`/admin/api/devices/test-uno/history?limit=${limit}`, { headers })).status, 400);
    }
    for (const asset of ['/admin/admin.css', '/admin/admin.js']) {
      assert.equal((await request(asset, { headers })).status, 200);
    }
    assert.equal((await request('/login')).status, 200);
    assert.equal((await request('/login', { headers })).status, 302);
  });
  await t.test('enforces per-IP history and ticket permissions and admin roles', async () => {
    const headers = await loginAs('test-admin', 'test-password');
    assert.equal((await jsonRequest('/admin/api/users', {
      username: 'limited-user', password: 'limited-password', role: 'user',
    }, headers)).status, 201);
    const userId = (await db.query("SELECT id FROM system_users WHERE username='limited-user'")).rows[0].id;
    await db.query('INSERT INTO user_devices (user_id, device_id, lan_ip) VALUES ($1,$2,$3)',
      [userId, 'test-uno', '192.168.1.10']);
    await db.query(`INSERT INTO sensor_logs (device_id, lan_ip, timestamp_up, temperature)
      VALUES ('test-uno','192.168.1.11',NOW(),99)`);
    const limited = await loginAs('limited-user', 'limited-password');
    const devices = await (await request('/admin/api/devices', { headers: limited })).json();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].lan_ip, '192.168.1.10');
    const history = await (await request('/admin/api/devices/test-uno/history', { headers: limited })).json();
    assert.equal(history.length, 1);
    assert.equal(history[0].temperature, 24);
    assert.equal((await request('/admin/api/devices/test-uno/history?lan_ip=192.168.1.11', { headers: limited })).status, 403);
    assert.equal((await request('/admin/api/devices/unassigned/history', { headers: limited })).status, 403);
    assert.equal((await request('/admin/api/users', { headers: limited })).status, 403);
    assert.equal((await request('/admin/api/devices/test-uno', { method: 'DELETE', headers: limited })).status, 403);
    const accessRequest = await (await jsonRequest('/admin/api/devices/test-uno/access-request', {
      lan_ip: '192.168.1.10',
    }, limited)).json();
    assert.equal(accessRequest.status, 'pending');
    assert.equal((await jsonRequest('/admin/api/devices/test-uno/access-request', {
      lan_ip: '192.168.1.11',
    }, limited)).status, 403);
    assert.equal((await jsonRequest(`/admin/api/access-requests/${accessRequest.id}/decision`, { approve: true }, headers)).status, 200);
    const approved = await (await request(`/admin/api/access-requests/${accessRequest.id}/status`, { headers: limited })).json();
    assert.equal(approved.status, 'approved');
    assert.equal(approved.lanIp, '192.168.1.10');
    assert(JSON.parse(Buffer.from(approved.ticket, 'base64url')).payload.startsWith('test-uno:192.168.1.10:'));
    assert.equal((await jsonRequest('/admin/api/devices/test-uno/password', { password: 'device-test-password' }, headers)).status, 200);
    assert.equal((await jsonRequest('/admin/api/devices/test-uno/ticket', {
      lan_ip: '192.168.1.11', password: 'device-test-password',
    }, limited)).status, 403);
    const ticket = await (await jsonRequest('/admin/api/devices/test-uno/ticket', {
      lan_ip: '192.168.1.10', password: 'device-test-password',
    }, limited)).json();
    assert.equal(ticket.ok, true);
    const decoded = JSON.parse(Buffer.from(ticket.ticket, 'base64url'));
    const crypto = require('node:crypto');
    assert.equal(decoded.sig, crypto.createHmac('sha256', 'test-sensor-key').update(decoded.payload).digest('hex'));
    assert(decoded.payload.startsWith('test-uno:192.168.1.10:'));
    assert.equal((await jsonRequest(`/admin/api/users/${userId}/devices`, {
      devices: [{ device_id: 'test-uno', lan_ip: '999.1.1.1' }],
    }, headers, 'PUT')).status, 400);
    assert.equal((await db.query('SELECT * FROM user_devices WHERE user_id=$1', [userId])).rowCount, 1);
    assert.equal((await request(`/admin/api/users/${userId}`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await request('/admin/api/devices', { headers: limited })).status, 401);
  });
  await t.test('reports database readiness', async () => {
    assert.equal((await request('/healthz')).status, 200);
  });
  await t.test('timezone migration preserves instants on fresh schemas and repeated runs', async () => {
    const migration = await readFile(path.join(__dirname, '../../../database/migrations/002_timezone.sql'), 'utf8');
    const before = (await db.query('SELECT id, timestamp_up FROM sensor_logs ORDER BY id')).rows;
    await db.query(migration);
    await db.query(migration);
    assert.deepEqual((await db.query('SELECT id, timestamp_up FROM sensor_logs ORDER BY id')).rows, before);
    const client = await db.connect();
    try {
      await client.query('CREATE SCHEMA legacy_test');
      await client.query('SET search_path TO legacy_test');
      await client.query(`CREATE TABLE sensor_logs (timestamp_real timestamp, timestamp_up timestamp);
        CREATE TABLE system_users (created_at timestamp);
        INSERT INTO sensor_logs VALUES ('2026-10-16 14:00:00','2026-10-16 14:00:01');
        INSERT INTO system_users VALUES ('2026-10-16 07:00:00')`);
      await client.query(migration);
      await client.query(migration);
      const row = (await client.query('SELECT * FROM sensor_logs CROSS JOIN system_users')).rows[0];
      assert.equal(row.timestamp_real.toISOString(), '2026-10-16T07:00:00.000Z');
      assert.equal(row.timestamp_up.toISOString(), '2026-10-16T07:00:01.000Z');
      assert.equal(row.created_at.toISOString(), '2026-10-16T07:00:00.000Z');
    } finally {
      await client.query('SET search_path TO public');
      await client.query('DROP SCHEMA legacy_test CASCADE');
      client.release();
    }
  });
});
