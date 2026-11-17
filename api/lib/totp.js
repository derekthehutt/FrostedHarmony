'use strict';

// Two-step sign-in codes (TOTP, RFC 6238): the 6-digit codes shown by authenticator apps such as
// Google Authenticator, Microsoft Authenticator or 1Password. Built on Node's own crypto.

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
// Codes from the step before and after are accepted too, for phone clocks that are slightly off.
const WINDOW = 1;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const number = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(number).padStart(DIGITS, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

// Returns the matching time step, or null. Steps at or before lastStep are refused, so a code
// that was already used (for example one seen over someone's shoulder) can't be used again.
function verify(secret, code, { now = Date.now(), lastStep = -1 } = {}) {
  const typed = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const current = stepAt(now);
  for (let step = current - WINDOW; step <= current + WINDOW; step += 1) {
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(typed))) return step;
  }
  return null;
}

// The link an authenticator app reads from the QR code.
function otpauthUri(secret, { issuer, account }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

// One-time recovery codes for a lost phone, for example "k7m2-q9xd-4f".
function recoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).toLowerCase().slice(0, 10);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 10)}`;
  });
}
const normalizeRecoveryCode = (code) => String(code || '').toLowerCase().replace(/[^a-z2-7]/g, '');

module.exports = { newSecret, codeAt, stepAt, verify, otpauthUri, recoveryCodes, normalizeRecoveryCode, base32Encode, base32Decode, STEP_SECONDS };
