'use strict';

// Runs the real server (without the Instagram timer) against a throwaway data folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-server-'));
process.env.DATA_DIR = dataDir;
process.env.ADMIN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SMTP_HOST = '';
process.env.INSTAGRAM_ACCESS_TOKEN = '';
const app = require('../server');

let base;
const PASSWORD = 'integration test password';

test.before(async () => {
  await app.init();
  await app.auth.createUser('derek', PASSWORD);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.after(() => new Promise((resolve) => app.server.close(resolve)));

function request(pathname, { method = 'GET', body, cookie, csrf, origin, ip = '127.0.0.1' } = {}) {
  const headers = { 'X-Real-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (origin) headers.Origin = origin;
  return fetch(base + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function signIn(ip = '127.0.0.1') {
  const res = await request('/api/admin/login', { method: 'POST', body: { username: 'derek', password: PASSWORD }, ip });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const { csrf } = await res.json();
  return { cookie: setCookie.split(';')[0], csrf };
}

test('public endpoints keep working', async () => {
  const health = await (await request('/api/health')).json();
  assert.deepEqual(health, { ok: true, instagramPosts: 0, email: false });
  assert.deepEqual((await (await request('/api/instagram')).json()).items, []);
  const bad = await request('/api/inquiry', { method: 'POST', body: { name: 'A', email: 'a@b.co', message: 'short' } });
  assert.equal(bad.status, 400);
  const notConfigured = await request('/api/inquiry', { method: 'POST', body: { name: 'A', email: 'a@b.co', message: 'long enough message' } });
  assert.equal(notConfigured.status, 503);
  assert.match(fs.readFileSync(path.join(dataDir, 'inquiries.jsonl'), 'utf8'), /long enough message/);
});

test('admin routes require sign-in', async () => {
  assert.equal((await request('/api/admin/status')).status, 200);
  for (const [pathname, method] of [['/api/admin/me', 'GET'], ['/api/admin/settings', 'GET'], ['/api/admin/dashboard', 'GET'], ['/api/admin/settings', 'PUT']]) {
    const res = await request(pathname, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${pathname}`);
  }
  const forged = await request('/api/admin/me', { cookie: '__Host-fh_admin=made-up-token' });
  assert.equal(forged.status, 401);
});

test('wrong password is rejected with a generic message', async () => {
  const res = await request('/api/admin/login', { method: 'POST', body: { username: 'derek', password: 'not the password' }, ip: '10.1.1.1' });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'Sign-in failed. Check your username and password.');
});

test('changes need the CSRF token and a same-site Origin', async () => {
  const { cookie, csrf } = await signIn();
  const body = { changes: { siteName: 'Frosted Harmony Bakery' } };
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body, cookie })).status, 403);
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body, cookie, csrf: 'wrong' })).status, 403);
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body, cookie, csrf, origin: 'https://evil.example' })).status, 403);
  const ok = await request('/api/admin/settings', { method: 'PUT', body, cookie, csrf, origin: base });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).changed, ['siteName']);
});

test('settings: secrets are write-only and take effect live', async () => {
  const { cookie, csrf } = await signIn();
  const res = await request('/api/admin/settings', {
    method: 'PUT', cookie, csrf,
    body: { changes: { smtpHost: 'smtp.example.com', smtpUser: 'sender@example.com', smtpPass: 'app password value', mailTo: 'owner@example.com' } },
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(body).includes('app password value'));
  assert.equal(body.settings.find((s) => s.name === 'smtpPass').isSet, true);
  assert.equal((await (await request('/api/health')).json()).email, true);

  const onDisk = fs.readFileSync(path.join(dataDir, 'admin', 'settings.json'), 'utf8');
  assert.ok(!onDisk.includes('app password value'));

  const invalid = await request('/api/admin/settings', { method: 'PUT', cookie, csrf, body: { changes: { mailTo: 'nope' } } });
  assert.equal(invalid.status, 400);
});

test('dashboard, sessions, password change and logout', async () => {
  const first = await signIn('10.2.0.1');
  const second = await signIn('10.2.0.2');
  const dashboard = await (await request('/api/admin/dashboard', { cookie: first.cookie })).json();
  assert.equal(dashboard.ok, true);
  assert.ok(dashboard.activity.some((entry) => entry.action === 'login'));
  assert.ok(Array.isArray(dashboard.inquiries));

  const sessions = await (await request('/api/admin/sessions', { cookie: first.cookie })).json();
  assert.ok(sessions.sessions.length >= 2);

  const revoke = await request('/api/admin/sessions/revoke-others', { method: 'POST', cookie: first.cookie, csrf: first.csrf, body: {} });
  assert.equal(revoke.status, 200);
  assert.equal((await request('/api/admin/me', { cookie: second.cookie })).status, 401);

  const logout = await request('/api/admin/logout', { method: 'POST', cookie: first.cookie, csrf: first.csrf, body: {} });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request('/api/admin/me', { cookie: first.cookie })).status, 401);
});

test('the audit log records actions without secrets', async () => {
  const log = fs.readFileSync(path.join(dataDir, 'admin', 'audit.log'), 'utf8');
  assert.match(log, /"action":"settings-changed"/);
  assert.match(log, /"action":"login-failed"/);
  assert.ok(!log.includes(PASSWORD) && !log.includes('app password value') && !log.includes('not the password'));
});

test('admin files are private to the API user (Linux/macOS only)', { skip: process.platform === 'win32' }, () => {
  for (const name of ['users.json', 'sessions.json', 'settings.json', 'audit.log']) {
    assert.equal(fs.statSync(path.join(dataDir, 'admin', name)).mode & 0o077, 0, name);
  }
});
