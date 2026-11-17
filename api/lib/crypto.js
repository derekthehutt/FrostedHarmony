'use strict';

// Password hashing (scrypt) and secret encryption (AES-256-GCM) using only node:crypto.

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// OWASP-recommended scrypt cost: N=2^17, r=8, p=1 (about 128 MiB and a few hundred ms per hash).
const DEFAULT_SCRYPT = { N: 2 ** 17, r: 8, p: 1 };
const KEY_LENGTH = 64;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;

function scryptOptions({ N, r, p }) {
  return { N, r, p, maxmem: 256 * N * r };
}

async function hashPassword(password, params = DEFAULT_SCRYPT) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, scryptOptions(params));
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!salt.length || expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, scryptOptions({ N, r, p }));
  return crypto.timingSafeEqual(actual, expected);
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  return null;
}

// ADMIN_ENCRYPTION_KEY: 32 random bytes as 64 hex characters (openssl rand -hex 32) or base64.
function parseKey(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(text)) key = Buffer.from(text, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) key = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!key || key.length !== 32) {
    throw new Error('ADMIN_ENCRYPTION_KEY must be 32 bytes: 64 hex characters (generate with: openssl rand -hex 32).');
  }
  return key;
}

// The label (for example the setting name) is bound to the ciphertext, so an encrypted value
// copied into a different field fails to decrypt instead of being accepted.
function encrypt(key, plaintext, label) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(label)));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(key, envelope, label) {
  const parts = String(envelope).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unrecognized encrypted value.');
  const [iv, tag, ciphertext] = parts.slice(1).map((part) => Buffer.from(part, 'base64'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Unrecognized encrypted value.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(String(label)));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = {
  DEFAULT_SCRYPT, PASSWORD_MIN, PASSWORD_MAX,
  hashPassword, verifyPassword, passwordProblem,
  parseKey, encrypt, decrypt, randomToken, sha256, safeEqual,
};
