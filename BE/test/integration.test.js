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
  for (const filename of ['DB.sql', 'auth_migration.sql']) {
    await db.query(await readFile(path.join(__dirname, '../../DB', filename), 'utf8'));
  }
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  server = spawn(process.execPath, ['index.js'], {
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
    if (logs.includes('Seeded admin user')) break;
    assert(attempt < 100 && server.exitCode === null, logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const request = (route, options) => fetch(base + route, { redirect: 'manual', ...options });
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
});
