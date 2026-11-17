'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuth } = require('../lib/auth');

const FAST = { N: 2 ** 10, r: 8, p: 1 };

async function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-auth-'));
  let clock = 1_800_000_000_000;
  const auth = createAuth({ dir, scryptParams: FAST, now: () => clock, limits: { minLoginMs: 0 }, ...options });
  await auth.load();
  await auth.createUser('Derek', 'a long test password');
  return { dir, auth, tick: (ms) => { clock += ms; } };
}

const cookieFor = (auth, token) => `${auth.cookieName}=${token}`;

test('users are stored with hashed passwords only', async () => {
  const { dir, auth } = await setup();
  const raw = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
  assert.ok(!raw.includes('a long test password'));
  assert.match(raw, /"username": "derek"/);
  await assert.rejects(auth.createUser('derek', 'another long password'), /already exists/);
  await assert.rejects(auth.createUser('x', 'another long password'), /3-32/);
  await assert.rejects(auth.createUser('wife', 'short'), /at least 12/);
});

test('a successful login creates a session; the cookie token is not stored', async () => {
  const { dir, auth } = await setup();
  const result = await auth.login('DEREK', 'a long test password', { ip: '1.1.1.1' });
  assert.equal(result.ok, true);
  assert.ok(result.csrf);
  const stored = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
  assert.ok(!stored.includes(result.token));
  const current = await auth.authenticate(cookieFor(auth, result.token));
  assert.equal(current.user.username, 'derek');
  assert.equal(auth.checkCsrf(current.session, result.csrf), true);
  assert.equal(auth.checkCsrf(current.session, 'wrong'), false);
  assert.equal(auth.checkCsrf(current.session, undefined), false);
});

test('wrong password and unknown user give the same error', async () => {
  const { auth } = await setup();
  const bad = await auth.login('derek', 'wrong password!!', { ip: '1.1.1.2' });
  const unknown = await auth.login('nobody', 'wrong password!!', { ip: '1.1.1.3' });
  assert.equal(bad.status, 401);
  assert.equal(bad.error, unknown.error);
});

test('5 failures from one IP are rate limited', async () => {
  const { auth, tick } = await setup();
  for (let i = 0; i < 5; i += 1) assert.equal((await auth.login('derek', 'wrong password!!', { ip: '9.9.9.9' })).status, 401);
  const blocked = await auth.login('derek', 'a long test password', { ip: '9.9.9.9' });
  assert.equal(blocked.status, 429);
  assert.equal((await auth.login('derek', 'a long test password', { ip: '8.8.8.8' })).ok, true);
  tick(16 * 60 * 1000);
  assert.equal((await auth.login('derek', 'a long test password', { ip: '9.9.9.9' })).ok, true);
});

test('10 failures lock the account for 15 minutes, even with the right password', async () => {
  const { auth, tick } = await setup();
  for (let i = 0; i < 10; i += 1) await auth.login('derek', 'wrong password!!', { ip: `10.0.0.${i}` });
  const locked = await auth.login('derek', 'a long test password', { ip: '10.0.1.1' });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'locked');
  tick(16 * 60 * 1000);
  assert.equal((await auth.login('derek', 'a long test password', { ip: '10.0.1.2' })).ok, true);
});

test('sessions expire after 30 idle minutes and after 12 hours in total', async () => {
  const { auth, tick } = await setup();
  const first = await auth.login('derek', 'a long test password', { ip: '1.1.1.1' });
  tick(29 * 60 * 1000);
  assert.ok(await auth.authenticate(cookieFor(auth, first.token)));
  tick(31 * 60 * 1000);
  assert.equal(await auth.authenticate(cookieFor(auth, first.token)), null);

  const second = await auth.login('derek', 'a long test password', { ip: '1.1.1.1' });
  for (let i = 0; i < 25; i += 1) {
    tick(29 * 60 * 1000);
    await auth.authenticate(cookieFor(auth, second.token));
  }
  assert.equal(await auth.authenticate(cookieFor(auth, second.token)), null);
});

test('logout and password change end sessions', async () => {
  const { auth } = await setup();
  const a = await auth.login('derek', 'a long test password', { ip: '1.1.1.1' });
  const b = await auth.login('derek', 'a long test password', { ip: '1.1.1.2' });
  const sessionA = (await auth.authenticate(cookieFor(auth, a.token))).session;
  assert.equal(auth.listSessions(sessionA).length, 2);

  assert.equal((await auth.changePassword(sessionA, 'wrong', 'a new long password')).ok, false);
  assert.equal((await auth.changePassword(sessionA, 'a long test password', 'short')).ok, false);
  const changed = await auth.changePassword(sessionA, 'a long test password', 'a new long password');
  assert.deepEqual(changed, { ok: true, signedOut: 1 });
  assert.equal(await auth.authenticate(cookieFor(auth, b.token)), null);
  assert.ok(await auth.authenticate(cookieFor(auth, a.token)));
  assert.equal((await auth.login('derek', 'a long test password', { ip: '1.1.1.3' })).ok, false);

  await auth.logout(sessionA);
  assert.equal(await auth.authenticate(cookieFor(auth, a.token)), null);
});

test('resetPassword unlocks the account and signs out every session', async () => {
  const { auth } = await setup();
  const a = await auth.login('derek', 'a long test password', { ip: '1.1.1.1' });
  for (let i = 0; i < 10; i += 1) await auth.login('derek', 'wrong password!!', { ip: `10.0.0.${i}` });
  await auth.resetPassword('derek', 'recovered password');
  assert.equal(await auth.authenticate(cookieFor(auth, a.token)), null);
  assert.equal((await auth.login('derek', 'recovered password', { ip: '1.1.1.9' })).ok, true);
});

test('parallel sign-in attempts from one IP cannot get past the limit', async () => {
  const { auth } = await setup();
  const results = await Promise.all(Array.from({ length: 12 }, () => auth.login('derek', 'wrong password!!', { ip: '7.7.7.7' })));
  assert.equal(results.filter((r) => r.status === 401).length, 5);
  assert.equal(results.filter((r) => r.status === 429).length, 7);
});

test('changes made by the SSH script apply to a running server without a restart', async () => {
  const { dir, auth: server } = await setup();
  const serverLogin = await server.login('derek', 'a long test password', { ip: '1.1.1.1' });

  const cli = createAuth({ dir, scryptParams: FAST, limits: { minLoginMs: 0 } });
  await cli.load();
  await cli.createUser('wife', 'her long password');
  assert.equal((await server.login('wife', 'her long password', { ip: '1.1.1.2' })).ok, true);

  await cli.resetPassword('derek', 'recovered password');
  assert.equal(await server.authenticate(`${server.cookieName}=${serverLogin.token}`), null);
  assert.equal((await server.login('derek', 'a long test password', { ip: '1.1.1.3' })).ok, false);

  // The server's own later writes must not undo the script's changes.
  await server.login('wife', 'wrong password!!', { ip: '1.1.1.4' });
  const fresh = createAuth({ dir, scryptParams: FAST, limits: { minLoginMs: 0 } });
  await fresh.load();
  assert.deepEqual(fresh.listUsers().map((u) => u.username).sort(), ['derek', 'wife']);
  assert.equal((await fresh.login('derek', 'recovered password', { ip: '1.1.1.5' })).ok, true);
});

test('a revoked session stays revoked when reloads overlap with writes', async () => {
  for (let run = 0; run < 60; run += 1) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-auth-race-'));
    const auth = createAuth({ dir, scryptParams: FAST, limits: { minLoginMs: 0, touchPersistMs: 0 } });
    await auth.load();
    await auth.createUser('derek', 'a long test password');
    const owner = await auth.login('derek', 'a long test password', { ip: '1.1.1.1' });
    const other = await auth.login('derek', 'a long test password', { ip: '1.1.1.2' });
    const ownerSession = (await auth.authenticate(cookieFor(auth, owner.token))).session;

    let stop = false;
    const reloads = (async () => {
      while (!stop) await auth.sync();
    })();
    await Promise.all([auth.authenticate(cookieFor(auth, other.token)), auth.revokeOtherSessions(ownerSession)]);
    stop = true;
    await reloads;

    assert.equal(await auth.authenticate(cookieFor(auth, other.token)), null, `run ${run}`);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')).sessions;
    assert.equal(onDisk.length, 1, `run ${run}`);
  }
});

test('sessions survive a restart', async () => {
  const { dir, auth } = await setup();
  const a = await auth.login('derek', 'a long test password', { ip: '1.1.1.1' });
  const again = createAuth({ dir, scryptParams: FAST, limits: { minLoginMs: 0 } });
  await again.load();
  assert.ok(await again.authenticate(`${again.cookieName}=${a.token}`));
});

test('cookies are HttpOnly, SameSite=Strict and Secure with the __Host- prefix', async () => {
  const { auth } = await setup();
  const cookie = auth.sessionCookie('token123');
  assert.match(cookie, /^__Host-fh_admin=token123; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  assert.match(auth.clearCookie(), /Max-Age=0/);
  const dev = createAuth({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fh-auth-')), secureCookies: false });
  assert.doesNotMatch(dev.sessionCookie('t'), /Secure|__Host-/);
});
