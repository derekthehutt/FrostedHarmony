'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettings } = require('../lib/settings');

function setup(env = {}, key = crypto.randomBytes(32)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-settings-'));
  const file = path.join(dir, 'settings.json');
  return { file, key, settings: createSettings({ file, key, env }) };
}

test('falls back from portal value to .env to default', async () => {
  const { settings } = setup({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587' });
  await settings.load();
  assert.equal(settings.get('smtpHost'), 'smtp.gmail.com');
  assert.equal(settings.source('smtpHost'), 'env');
  assert.equal(settings.get('smtpPort'), 587);
  assert.equal(settings.get('siteName'), 'Frosted Harmony');
  assert.equal(settings.source('siteName'), 'default');

  const result = await settings.update({ changes: { smtpHost: 'mail.example.com' } }, 'derek');
  assert.deepEqual(result.changed, ['smtpHost']);
  assert.equal(settings.get('smtpHost'), 'mail.example.com');
  assert.equal(settings.source('smtpHost'), 'portal');

  await settings.update({ reset: ['smtpHost'] }, 'derek');
  assert.equal(settings.get('smtpHost'), 'smtp.gmail.com');
});

test('a bad number in .env is clamped like before', async () => {
  const { settings } = setup({ INSTAGRAM_POST_LIMIT: '500', SMTP_PORT: 'abc' });
  await settings.load();
  assert.equal(settings.get('instagramPostLimit'), 50);
  assert.equal(settings.get('smtpPort'), 465);
});

test('secrets are encrypted on disk and never described in plain text', async () => {
  const { settings, file, key } = setup();
  await settings.load();
  await settings.update({ changes: { smtpPass: 'abcd efgh ijkl mnop', instagramToken: 'IGAAtoken123' } }, 'derek');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('abcdefghijklmnop') && !raw.includes('abcd efgh'));
  assert.ok(!raw.includes('IGAAtoken123'));
  assert.equal(settings.get('smtpPass'), 'abcdefghijklmnop');

  const described = JSON.stringify(settings.describe());
  assert.ok(!described.includes('abcdefghijklmnop') && !described.includes('IGAAtoken123'));
  assert.equal(settings.describe().find((s) => s.name === 'smtpPass').isSet, true);

  const reloaded = createSettings({ file, key, env: {} });
  await reloaded.load();
  assert.equal(reloaded.get('instagramToken'), 'IGAAtoken123');
});

test('an empty secret box keeps the current secret', async () => {
  const { settings } = setup();
  await settings.load();
  await settings.update({ changes: { smtpPass: 'first-password' } }, 'derek');
  const result = await settings.update({ changes: { smtpPass: '' } }, 'derek');
  assert.deepEqual(result.changed, []);
  assert.equal(settings.get('smtpPass'), 'first-password');
});

test('with the wrong key a saved secret is ignored and reported, not exposed', async () => {
  const { settings, file } = setup({ SMTP_PASS: 'from-env' });
  await settings.load();
  await settings.update({ changes: { smtpPass: 'from-portal' } }, 'derek');
  const other = createSettings({ file, key: crypto.randomBytes(32), env: { SMTP_PASS: 'from-env' } });
  await other.load();
  assert.equal(other.get('smtpPass'), 'from-env');
  assert.match(other.problems().join(' '), /could not be decrypted/);
});

test('invalid input is rejected and nothing is saved', async () => {
  const { settings, file } = setup();
  await settings.load();
  const result = await settings.update({ changes: { mailTo: 'not-an-email', smtpPort: '99999', siteName: 'OK name' } }, 'derek');
  assert.equal(result.errors.length, 2);
  assert.equal(fs.existsSync(file), false);
  assert.equal(settings.get('siteName'), 'Frosted Harmony');

  assert.ok((await settings.update({ changes: { siteName: '' } }, 'derek')).errors);
  assert.ok((await settings.update({ changes: { smtpHost: 'bad host!' } }, 'derek')).errors);
  assert.ok((await settings.update({ changes: { nope: 'x' } }, 'derek')).errors);
  assert.ok((await settings.update({ changes: { siteName: 'line\nbreak' } }, 'derek')).errors);
});

test('without an encryption key, secrets cannot be saved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-settings-'));
  const settings = createSettings({ file: path.join(dir, 'settings.json'), key: null, env: {} });
  await settings.load();
  const result = await settings.update({ changes: { smtpPass: 'secret-value' } }, 'derek');
  assert.match(result.errors.join(' '), /ADMIN_ENCRYPTION_KEY/);
});

test('change listeners receive the changed setting names', async () => {
  const { settings } = setup();
  await settings.load();
  const seen = [];
  settings.onChange((names) => seen.push(names));
  await settings.update({ changes: { instagramPostLimit: '8' } }, 'derek');
  assert.deepEqual(seen, [['instagramPostLimit']]);
});
