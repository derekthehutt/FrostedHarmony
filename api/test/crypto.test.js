'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const c = require('../lib/crypto');

const FAST = { N: 2 ** 10, r: 8, p: 1 };

test('hashPassword/verifyPassword accept the right password and reject others', async () => {
  const hash = await c.hashPassword('correct horse battery', FAST);
  assert.match(hash, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await c.verifyPassword('correct horse battery', hash), true);
  assert.equal(await c.verifyPassword('correct horse batterY', hash), false);
  assert.equal(await c.verifyPassword('', hash), false);
});

test('the same password hashes differently each time (random salt)', async () => {
  assert.notEqual(await c.hashPassword('same password here', FAST), await c.hashPassword('same password here', FAST));
});

test('verifyPassword rejects malformed or hostile hashes without throwing', async () => {
  for (const bad of ['', 'plain', 'scrypt$1$8$1$AAAA$BBBB', 'scrypt$99999999$8$1$AAAA$BBBB', 'bcrypt$x$y$z$a$b', null]) {
    assert.equal(await c.verifyPassword('anything', bad), false);
  }
});

test('passwordProblem enforces length limits', () => {
  assert.match(c.passwordProblem('short'), /at least 12/);
  assert.equal(c.passwordProblem('long enough pass'), null);
  assert.match(c.passwordProblem('x'.repeat(257)), /at most 256/);
});

test('parseKey accepts 64 hex characters or base64 and rejects anything else', () => {
  const raw = crypto.randomBytes(32);
  assert.deepEqual(c.parseKey(raw.toString('hex')), raw);
  assert.deepEqual(c.parseKey(raw.toString('base64')), raw);
  assert.equal(c.parseKey(''), null);
  assert.throws(() => c.parseKey('abc123'), /32 bytes/);
});

test('encrypt/decrypt round-trips and never stores the plaintext', () => {
  const key = crypto.randomBytes(32);
  const envelope = c.encrypt(key, 'my smtp password', 'setting:smtpPass');
  assert.ok(!envelope.includes('my smtp password'));
  assert.equal(c.decrypt(key, envelope, 'setting:smtpPass'), 'my smtp password');
  assert.notEqual(c.encrypt(key, 'same', 'x'), c.encrypt(key, 'same', 'x'));
});

test('decrypt fails for tampered data, the wrong key, or a value moved to another field', () => {
  const key = crypto.randomBytes(32);
  const envelope = c.encrypt(key, 'secret', 'setting:smtpPass');
  const parts = envelope.split(':');
  const ct = Buffer.from(parts[3], 'base64');
  ct[0] ^= 1;
  parts[3] = ct.toString('base64');
  assert.throws(() => c.decrypt(key, parts.join(':'), 'setting:smtpPass'));
  assert.throws(() => c.decrypt(crypto.randomBytes(32), envelope, 'setting:smtpPass'));
  assert.throws(() => c.decrypt(key, envelope, 'setting:instagramToken'));
  assert.throws(() => c.decrypt(key, 'garbage', 'setting:smtpPass'));
});

test('safeEqual compares exactly', () => {
  assert.equal(c.safeEqual('abc', 'abc'), true);
  assert.equal(c.safeEqual('abc', 'abd'), false);
  assert.equal(c.safeEqual('abc', 'abcd'), false);
});
