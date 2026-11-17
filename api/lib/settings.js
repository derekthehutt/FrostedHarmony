'use strict';

// Live site settings. Values saved in the admin portal (settings.json) override .env, which
// overrides the built-in default. Secrets are stored encrypted and never returned to the browser.

const { readJson, writeJson } = require('./store');
const { encrypt, decrypt } = require('./crypto');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

const SCHEMA = [
  { name: 'siteName', env: 'SITE_NAME', group: 'General', label: 'Site name', type: 'text', max: 80, required: true, default: 'Frosted Harmony',
    help: 'Used in inquiry email subjects and the admin portal.' },
  { name: 'mailTo', env: 'MAIL_TO', group: 'Email', label: 'Send inquiries to', type: 'email',
    help: 'Where website inquiries are delivered. Leave empty to use the SMTP username.' },
  { name: 'mailFrom', env: 'MAIL_FROM', group: 'Email', label: 'Send from address', type: 'email',
    help: 'For Gmail this must be the same as the SMTP username. Leave empty to use the SMTP username.' },
  { name: 'smtpHost', env: 'SMTP_HOST', group: 'Email', label: 'SMTP server', type: 'host', help: 'For Gmail: smtp.gmail.com' },
  { name: 'smtpPort', env: 'SMTP_PORT', group: 'Email', label: 'SMTP port', type: 'int', min: 1, max: 65535, default: 465,
    help: '465 (SSL) or 587 (STARTTLS).' },
  { name: 'smtpUser', env: 'SMTP_USER', group: 'Email', label: 'SMTP username', type: 'text', max: 200 },
  { name: 'smtpPass', env: 'SMTP_PASS', group: 'Email', label: 'SMTP password', type: 'secret', max: 200, stripSpaces: true,
    help: 'For Gmail, a 16-letter App password.' },
  { name: 'instagramToken', env: 'INSTAGRAM_ACCESS_TOKEN', group: 'Instagram', label: 'Instagram access token', type: 'secret', max: 4096, stripSpaces: true },
  { name: 'instagramPostLimit', env: 'INSTAGRAM_POST_LIMIT', group: 'Instagram', label: 'Posts to show', type: 'int', min: 1, max: 50, default: 12 },
];
const BY_NAME = new Map(SCHEMA.map((field) => [field.name, field]));

function normalize(field, raw) {
  if (raw === undefined || raw === null) return { value: undefined };
  if (field.type === 'int') {
    const text = String(raw).trim();
    if (!/^-?\d+$/.test(text)) return { error: `${field.label} must be a whole number.` };
    const n = Number(text);
    if (n < field.min || n > field.max) return { error: `${field.label} must be between ${field.min} and ${field.max}.` };
    return { value: n };
  }
  let text = String(raw);
  text = field.stripSpaces ? text.replace(/\s+/g, '') : text.trim();
  if (field.max && text.length > field.max) return { error: `${field.label} must be at most ${field.max} characters.` };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { error: `${field.label} contains invalid characters.` };
  if (!text) return { value: '' };
  if (field.type === 'email' && !EMAIL.test(text)) return { error: `${field.label} must be an email address.` };
  if (field.type === 'host' && !HOST.test(text)) return { error: `${field.label} must be a host name such as smtp.gmail.com.` };
  return { value: text };
}

function createSettings({ file, key, env = process.env }) {
  let state = { values: {}, updated: {} };
  const listeners = [];
  const problems = new Set();

  async function load() {
    const saved = await readJson(file, null);
    state = { values: {}, updated: {}, ...(saved || {}) };
    for (const name of Object.keys(state.values)) {
      if (!BY_NAME.has(name)) delete state.values[name];
    }
  }

  function envValue(field) {
    if (env[field.env] === undefined || env[field.env] === '') return undefined;
    const { value, error } = normalize(field, env[field.env]);
    if (error) {
      // Mirror the old behaviour: a bad .env number falls back to the default (clamped if possible).
      if (field.type === 'int' && /^-?\d+$/.test(String(env[field.env]).trim())) {
        return Math.min(field.max, Math.max(field.min, Number(env[field.env])));
      }
      return undefined;
    }
    return value === '' ? undefined : value;
  }

  function portalValue(field) {
    if (!Object.prototype.hasOwnProperty.call(state.values, field.name)) return undefined;
    const stored = state.values[field.name];
    if (field.type !== 'secret') return stored;
    if (!key) {
      problems.add(`${field.label} is saved encrypted, but ADMIN_ENCRYPTION_KEY is not set.`);
      return undefined;
    }
    try {
      return decrypt(key, stored, `setting:${field.name}`);
    } catch {
      problems.add(`${field.label} could not be decrypted (was ADMIN_ENCRYPTION_KEY changed?). Enter it again.`);
      return undefined;
    }
  }

  function source(name) {
    const field = BY_NAME.get(name);
    if (portalValue(field) !== undefined) return 'portal';
    if (envValue(field) !== undefined) return 'env';
    return 'default';
  }

  function get(name) {
    const field = BY_NAME.get(name);
    if (!field) throw new Error(`Unknown setting: ${name}`);
    const fromPortal = portalValue(field);
    if (fromPortal !== undefined) return fromPortal;
    const fromEnv = envValue(field);
    if (fromEnv !== undefined) return fromEnv;
    return field.default !== undefined ? field.default : '';
  }

  // Safe for the browser: secret values are replaced by whether they are set.
  function describe() {
    return SCHEMA.map((field) => {
      const entry = {
        name: field.name, group: field.group, label: field.label, type: field.type, help: field.help || '',
        min: field.min, max: field.max, required: Boolean(field.required),
        source: source(field.name), updatedAt: (state.updated[field.name] || {}).at || null,
        updatedBy: (state.updated[field.name] || {}).by || null,
      };
      if (field.type === 'secret') entry.isSet = Boolean(get(field.name));
      else entry.value = get(field.name);
      return entry;
    });
  }

  // changes: { name: value }. reset: [name] reverts to .env/default. Nothing is saved if any value is invalid.
  async function update({ changes = {}, reset = [] }, actor) {
    const errors = [];
    const next = { ...state.values };
    const touched = [];
    if (typeof changes !== 'object' || Array.isArray(changes) || !Array.isArray(reset)) {
      return { errors: ['Invalid request.'] };
    }
    for (const name of reset) {
      if (!BY_NAME.has(name)) errors.push(`Unknown setting: ${name}`);
      else if (Object.prototype.hasOwnProperty.call(next, name)) {
        delete next[name];
        touched.push(name);
      }
    }
    for (const [name, raw] of Object.entries(changes)) {
      const field = BY_NAME.get(name);
      if (!field) {
        errors.push(`Unknown setting: ${name}`);
        continue;
      }
      if (reset.includes(name)) continue;
      const { value, error } = normalize(field, raw);
      if (error) {
        errors.push(error);
        continue;
      }
      if (field.type === 'secret') {
        if (!value) continue; // An empty secret box means "keep the current value".
        if (!key) {
          errors.push('ADMIN_ENCRYPTION_KEY is not set, so secrets cannot be saved.');
          continue;
        }
        next[name] = encrypt(key, value, `setting:${name}`);
        touched.push(name);
        continue;
      }
      if (value === '') {
        if (field.required) {
          errors.push(`${field.label} is required.`);
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(next, name)) {
          delete next[name];
          touched.push(name);
        }
        continue;
      }
      if (next[name] !== value) {
        next[name] = value;
        touched.push(name);
      }
    }
    if (errors.length) return { errors };
    if (!touched.length) return { changed: [] };

    const updated = { ...state.updated };
    const at = new Date().toISOString();
    for (const name of touched) updated[name] = { at, by: actor || null };
    const nextState = { version: 1, values: next, updated };
    await writeJson(file, nextState);
    state = nextState;
    for (const name of touched) {
      for (const message of [...problems]) if (message.startsWith(BY_NAME.get(name).label)) problems.delete(message);
    }
    for (const listener of listeners) {
      try {
        listener(touched);
      } catch {
        // A listener failure must not undo a saved setting.
      }
    }
    return { changed: touched };
  }

  function onChange(listener) {
    listeners.push(listener);
  }

  return { load, get, source, describe, update, onChange, problems: () => [...problems], hasKey: Boolean(key) };
}

module.exports = { createSettings, SCHEMA };
