'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const totp = require('../lib/totp');
const { createAuth } = require('../lib/auth');

// RFC 6238 appendix B test secret ("12345678901234567890"), last 6 of the 8-digit SHA-1 values.
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));

test('codes match the RFC 6238 test vectors', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) {
    assert.equal(totp.codeAt(RFC_SECRET, totp.stepAt(seconds * 1000)), code, String(seconds));
  }
});

test('a code is accepted 30 seconds early or late, never twice, and never when malformed', () => {
  const now = 1_800_000_000_000;
  const step = totp.stepAt(now);
  const code = totp.codeAt(RFC_SECRET, step);
  assert.equal(totp.verify(RFC_SECRET, code, { now }), step);
  assert.equal(totp.verify(RFC_SECRET, code.replace(/(\d{3})/, '$1 '), { now }), step, 'a space in the middle is fine');
  assert.equal(totp.verify(RFC_SECRET, code, { now: now + 30_000 }), step, 'clock slightly off');
  assert.equal(totp.verify(RFC_SECRET, code, { now: now + 90_000 }), null, 'too old');
  assert.equal(totp.verify(RFC_SECRET, code, { now, lastStep: step }), null, 'already used');
  for (const bad of ['', '12345', '1234567', 'abcdef', null]) assert.equal(totp.verify(RFC_SECRET, bad, { now }), null);
});

test('setup links and recovery codes', () => {
  const secret = totp.newSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.deepEqual(totp.base32Decode(secret).length, 20);
  const uri = totp.otpauthUri(secret, { issuer: 'Frosted Harmony', account: 'derek' });
  assert.ok(uri.startsWith('otpauth://totp/Frosted%20Harmony%3Aderek?'));
  assert.equal(new URL(uri).searchParams.get('secret'), secret);
  const codes = totp.recoveryCodes();
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{2}$/);
  assert.equal(totp.normalizeRecoveryCode(' ABCD-efgh-23 '), 'abcdefgh23');
});

// ---------- Two-step sign-in in the auth module ----------

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'a long test password';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-2fa-'));
  let clock = 1_800_000_000_000;
  const auth = createAuth({ dir, key: crypto.randomBytes(32), scryptParams: FAST, now: () => clock, limits: { minLoginMs: 0 } });
  await auth.load();
  await auth.createUser('derek', PASSWORD);
  const first = await auth.login('derek', PASSWORD, { ip: '1.1.1.1' });
  return { dir, auth, session: first.session, tick: (ms) => { clock += ms; }, now: () => clock };
}

async function turnOn(ctx) {
  const started = await ctx.auth.startTwoFactor(ctx.session, { issuer: 'Frosted Harmony' });
  assert.equal(started.ok, true);
  const confirmed = await ctx.auth.confirmTwoFactor(ctx.session, totp.codeAt(started.secret, totp.stepAt(ctx.now())));
  assert.equal(confirmed.ok, true);
  return { secret: started.secret, recoveryCodes: confirmed.recoveryCodes };
}

test('turning on two-step sign-in stores the secret encrypted and shows recovery codes once', async () => {
  const ctx = await setup();
  const other = await ctx.auth.login('derek', PASSWORD, { ip: '2.2.2.2' });
  const started = await ctx.auth.startTwoFactor(ctx.session, { issuer: 'Frosted Harmony' });
  const wrong = await ctx.auth.confirmTwoFactor(ctx.session, '000000');
  assert.equal(wrong.ok, false);
  const confirmed = await ctx.auth.confirmTwoFactor(ctx.session, totp.codeAt(started.secret, totp.stepAt(ctx.now())));
  assert.equal(confirmed.recoveryCodes.length, 10);
  assert.equal(confirmed.signedOut, 1, 'other devices are signed out');
  assert.equal(await ctx.auth.authenticate(`${ctx.auth.cookieName}=${other.token}`), null);
  const raw = fs.readFileSync(path.join(ctx.dir, 'users.json'), 'utf8');
  assert.ok(!raw.includes(started.secret), 'the secret is not stored in plain text');
  assert.ok(!confirmed.recoveryCodes.some((c) => raw.includes(c)), 'recovery codes are stored as hashes');
  assert.deepEqual(ctx.auth.listUsers()[0].twoFactor, true);
});

test('setup expires after 10 minutes', async () => {
  const ctx = await setup();
  const started = await ctx.auth.startTwoFactor(ctx.session, { issuer: 'X' });
  ctx.tick(11 * 60 * 1000);
  const late = await ctx.auth.confirmTwoFactor(ctx.session, totp.codeAt(started.secret, totp.stepAt(ctx.now())));
  assert.match(late.error, /timed out/);
});

test('signing in then needs the code; a used code or recovery code cannot be used again', async () => {
  const ctx = await setup();
  const { secret, recoveryCodes } = await turnOn(ctx);
  ctx.tick(60_000);

  const first = await ctx.auth.login('derek', PASSWORD, { ip: '3.3.3.3' });
  assert.equal(first.ok, false);
  assert.equal(first.needsCode, true);
  assert.equal(first.token, undefined, 'no session before the code');
  const code = totp.codeAt(secret, totp.stepAt(ctx.now()));
  assert.equal((await ctx.auth.completeLogin(first.ticket, code, { ip: '9.9.9.9' })).reason, 'ticket', 'the ticket only works from the same IP');

  const again = await ctx.auth.login('derek', PASSWORD, { ip: '3.3.3.3' });
  const done = await ctx.auth.completeLogin(again.ticket, code, { ip: '3.3.3.3' });
  assert.equal(done.ok, true);
  assert.ok(done.token);
  assert.equal((await ctx.auth.completeLogin(again.ticket, code, { ip: '3.3.3.3' })).reason, 'ticket', 'a ticket works once');

  const replay = await ctx.auth.login('derek', PASSWORD, { ip: '4.4.4.4' });
  assert.equal((await ctx.auth.completeLogin(replay.ticket, code, { ip: '4.4.4.4' })).reason, 'bad-code', 'the same code cannot be used twice');
  const recovered = await ctx.auth.completeLogin(replay.ticket, recoveryCodes[0].toUpperCase(), { ip: '4.4.4.4' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.usedRecoveryCode, true);
  assert.equal(recovered.recoveryCodesLeft, 9);
  const reuse = await ctx.auth.login('derek', PASSWORD, { ip: '5.5.5.5' });
  assert.equal((await ctx.auth.completeLogin(reuse.ticket, recoveryCodes[0], { ip: '5.5.5.5' })).ok, false, 'recovery codes work once');
});

test('tickets expire, allow 3 wrong codes, and become useless when the password changes', async () => {
  const ctx = await setup();
  const { secret } = await turnOn(ctx);
  const slow = await ctx.auth.login('derek', PASSWORD, { ip: '6.6.6.1' });
  ctx.tick(6 * 60 * 1000);
  assert.equal((await ctx.auth.completeLogin(slow.ticket, totp.codeAt(secret, totp.stepAt(ctx.now())), { ip: '6.6.6.1' })).reason, 'ticket');

  const guessing = await ctx.auth.login('derek', PASSWORD, { ip: '6.6.6.2' });
  let last;
  for (let i = 0; i < 3; i += 1) last = await ctx.auth.completeLogin(guessing.ticket, '000000', { ip: '6.6.6.2' });
  assert.match(last.error, /Too many wrong codes/);
  assert.equal((await ctx.auth.completeLogin(guessing.ticket, totp.codeAt(secret, totp.stepAt(ctx.now())), { ip: '6.6.6.2' })).ok, false);

  const pending = await ctx.auth.login('derek', PASSWORD, { ip: '6.6.6.3' });
  await ctx.auth.setPasswordFor(ctx.auth.listUsers()[0].id, 'a different long password');
  assert.equal((await ctx.auth.completeLogin(pending.ticket, totp.codeAt(secret, totp.stepAt(ctx.now())), { ip: '6.6.6.3' })).reason, 'ticket');
});

test('knowing the password does not reset the lockout for wrong codes', async () => {
  const ctx = await setup();
  const { secret } = await turnOn(ctx);
  // Ten wrong codes spread over many IPs, each after a correct password, lock the account.
  for (let i = 0; i < 10; i += 1) {
    const step = await ctx.auth.login('derek', PASSWORD, { ip: `7.7.7.${i}` });
    assert.equal(step.needsCode, true, `attempt ${i}`);
    await ctx.auth.completeLogin(step.ticket, '000000', { ip: `7.7.7.${i}` });
  }
  const locked = await ctx.auth.login('derek', PASSWORD, { ip: '7.7.8.1' });
  assert.equal(locked.reason, 'locked');
  ctx.tick(16 * 60 * 1000);
  const later = await ctx.auth.login('derek', PASSWORD, { ip: '7.7.8.2' });
  assert.equal((await ctx.auth.completeLogin(later.ticket, totp.codeAt(secret, totp.stepAt(ctx.now())), { ip: '7.7.8.2' })).ok, true);
});

test('turning it off needs a current code; an owner or SSH can turn it off for a lost phone', async () => {
  const ctx = await setup();
  const { secret } = await turnOn(ctx);
  ctx.tick(60_000);
  assert.equal((await ctx.auth.disableTwoFactor(ctx.session, '000000')).ok, false);
  const renewed = await ctx.auth.newRecoveryCodes(ctx.session, totp.codeAt(secret, totp.stepAt(ctx.now())));
  assert.equal(renewed.recoveryCodes.length, 10);
  ctx.tick(60_000);
  assert.equal((await ctx.auth.disableTwoFactor(ctx.session, totp.codeAt(secret, totp.stepAt(ctx.now())))).ok, true);
  assert.equal(ctx.auth.listUsers()[0].twoFactor, false);
  await turnOn(ctx);
  await ctx.auth.disableTwoFactorFor(ctx.auth.listUsers()[0].id);
  assert.equal((await ctx.auth.login('derek', PASSWORD, { ip: '8.8.8.8' })).ok, true);
});

// ---------- Roles ----------

test('roles: there is always an owner; removing an admin signs them out', async () => {
  const ctx = await setup();
  const wife = await ctx.auth.createUser('baker', 'another long password', { role: 'editor' });
  assert.equal(wife.role, 'editor');
  const derek = ctx.auth.listUsers().find((u) => u.username === 'derek');
  assert.equal(derek.role, 'owner');
  assert.match((await ctx.auth.setRole(derek.id, 'editor')).error, /at least one owner/);
  assert.match((await ctx.auth.removeUser(derek.id)).error, /at least one owner/);
  assert.equal((await ctx.auth.setRole(wife.id, 'owner')).ok, true);
  assert.equal((await ctx.auth.setRole(derek.id, 'editor')).ok, true, 'fine once another owner exists');
  assert.equal((await ctx.auth.setRole(wife.id, 'admin')).ok, false);

  const signedIn = await ctx.auth.login('baker', 'another long password', { ip: '9.1.1.1' });
  const reset = await ctx.auth.setPasswordFor(wife.id, 'a brand new long password');
  assert.equal(reset.signedOut, 1);
  assert.equal(await ctx.auth.authenticate(`${ctx.auth.cookieName}=${signedIn.token}`), null);
  const back = await ctx.auth.login('baker', 'a brand new long password', { ip: '9.1.1.2' });
  await ctx.auth.setRole(derek.id, 'owner');
  assert.equal((await ctx.auth.removeUser(wife.id)).ok, true);
  assert.equal(await ctx.auth.authenticate(`${ctx.auth.cookieName}=${back.token}`), null);
});

test('admins created before roles existed are owners', async () => {
  const ctx = await setup();
  const file = path.join(ctx.dir, 'users.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete data.users[0].role;
  fs.writeFileSync(file, JSON.stringify(data));
  const fresh = createAuth({ dir: ctx.dir, scryptParams: FAST });
  await fresh.load();
  assert.equal(fresh.listUsers()[0].role, 'owner');
});

test('password confirmation counts wrong guesses toward the IP limit', async () => {
  const ctx = await setup();
  for (let i = 0; i < 5; i += 1) assert.equal((await ctx.auth.confirmPassword(ctx.session, 'wrong', '1.2.3.4')).status, 400);
  assert.equal((await ctx.auth.confirmPassword(ctx.session, PASSWORD, '1.2.3.4')).status, 429);
  assert.equal((await ctx.auth.confirmPassword(ctx.session, PASSWORD, '1.2.3.5')).ok, true);
});

test('used codes and recovery codes stay used after a restart', async () => {
  const ctx = await setup();
  const { secret, recoveryCodes } = await turnOn(ctx);
  ctx.tick(60_000);
  const code = totp.codeAt(secret, totp.stepAt(ctx.now()));
  const first = await ctx.auth.login('derek', PASSWORD, { ip: '5.1.1.1' });
  assert.equal((await ctx.auth.completeLogin(first.ticket, code, { ip: '5.1.1.1' })).ok, true);
  const second = await ctx.auth.login('derek', PASSWORD, { ip: '5.1.1.2' });
  assert.equal((await ctx.auth.completeLogin(second.ticket, recoveryCodes[1], { ip: '5.1.1.2' })).ok, true);

  const restarted = createAuth({ dir: ctx.dir, key: null, scryptParams: FAST, now: ctx.now, limits: { minLoginMs: 0 } });
  await restarted.load();
  const again = await restarted.login('derek', PASSWORD, { ip: '5.1.1.3' });
  assert.equal((await restarted.completeLogin(again.ticket, recoveryCodes[1], { ip: '5.1.1.3' })).ok, false, 'recovery code already used');
  assert.ok(restarted.listUsers()[0].lastLoginAt, 'last sign-in is remembered');
});