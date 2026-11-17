'use strict';

// Small API for the Frosted Harmony website.
//   GET  /api/health     -> health check
//   GET  /api/instagram  -> cached list of recent Instagram posts
//   POST /api/inquiry    -> emails a customer inquiry
//   /api/admin/*         -> admin portal (see routes/admin.js)
// On the Linux server this runs inside Docker behind nginx.
// Run with --dev on your PC to preview the whole site at http://localhost:8080.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const nodemailer = require('nodemailer');

const { writeJson, ensurePrivateDir } = require('./lib/store');
const { parseKey, encrypt, decrypt, sha256 } = require('./lib/crypto');
const { createSettings } = require('./lib/settings');
const { createAuth } = require('./lib/auth');
const { createAudit } = require('./lib/audit');
const { createContentStore } = require('./lib/content');
const { createMediaStore } = require('./lib/media');
const { createThemeAssets } = require('./lib/theme-assets');
const { createInquiryStore, INQUIRY_TYPES } = require('./lib/inquiries');
const { createInstagramClient, tokenKind } = require('./lib/instagram');
const { createBackups } = require('./lib/backup');
const { themeCss } = require('./lib/theme');
const { renderPage } = require('./lib/render');
const { createAdminRoutes } = require('./routes/admin');

const DEV = process.argv.includes('--dev') || process.env.FH_DEV === '1';
const PORT = Number(process.env.PORT || (DEV ? 8080 : 3000));
const DATA_DIR = path.resolve(process.env.DATA_DIR || (DEV ? path.join(__dirname, '..', '.local-data') : '/data'));
const STATIC_DIR = DEV ? path.resolve(__dirname, '..', 'site') : null;
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const ADMIN_DIR = path.join(DATA_DIR, 'admin');
// Pages published from the admin portal. nginx serves site/index.html from here when it exists.
const PUBLISHED_SITE_DIR = path.join(DATA_DIR, 'site');
// Resized photos from the admin portal, served by nginx at /uploads/.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
// Theme stylesheet and logo icons for the published page, served by nginx at /site-assets/.
const SITE_ASSETS_DIR = path.join(PUBLISHED_SITE_DIR, 'assets');
const TOKEN_FILE = path.join(DATA_DIR, 'instagram-token.json');
const FEED_FILE = path.join(MEDIA_DIR, 'feed.json');
const INQUIRY_LOG = path.join(DATA_DIR, 'inquiries.jsonl');

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const IG_REFRESH_MINUTES = clampInt(process.env.INSTAGRAM_REFRESH_MINUTES, 60, 10, 1440);
const TOKEN_REFRESH_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// The local preview keeps its own throwaway key so the admin portal can be tried without setup.
function loadEncryptionKey() {
  if (process.env.ADMIN_ENCRYPTION_KEY) return parseKey(process.env.ADMIN_ENCRYPTION_KEY);
  if (!DEV) return null;
  const devKeyFile = path.join(DATA_DIR, 'dev-admin-key');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(devKeyFile)) fs.writeFileSync(devKeyFile, require('node:crypto').randomBytes(32).toString('hex'), { mode: 0o600 });
  return parseKey(fs.readFileSync(devKeyFile, 'utf8'));
}

const ENCRYPTION_KEY = loadEncryptionKey();
const settings = createSettings({ file: path.join(ADMIN_DIR, 'settings.json'), key: ENCRYPTION_KEY });
const auth = createAuth({ dir: ADMIN_DIR, key: ENCRYPTION_KEY, secureCookies: !DEV });
const audit = createAudit(path.join(ADMIN_DIR, 'audit.log'));
const media = createMediaStore({ metaFile: path.join(ADMIN_DIR, 'media.json'), uploadDir: UPLOAD_DIR });
const themeAssets = createThemeAssets({ dir: SITE_ASSETS_DIR, uploadDir: UPLOAD_DIR });
const content = createContentStore({
  dir: path.join(ADMIN_DIR, 'content'), siteDir: PUBLISHED_SITE_DIR, render: renderPage, photos: () => media.lookup(),
  assets: (pageContent) => themeAssets.build(pageContent, media.lookup()),
});
const inquiries = createInquiryStore({ file: INQUIRY_LOG });
const instagram = createInstagramClient();
const backups = createBackups({
  dir: path.join(ADMIN_DIR, 'backups'), settings, content, inquiries, siteName: () => settings.get('siteName'),
});

const FIELD_LIMITS = {
  name: 100, email: 200, phone: 40, inquiryType: 40,
  eventDate: 40, quantity: 40, message: 3000, fh_trap: 200, website: 200,
};
// Spam-trap fields. "website" is the old name, kept for pages cached before the rename.
const TRAP_FIELDS = ['fh_trap', 'website'];
const RATE_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 };
const MAX_BODY_BYTES = 16 * 1024;

let feed = { items: [], updatedAt: null };
const recentInquiries = new Map();
const lastErrors = { instagram: null, email: null };
// The Instagram account the token belongs to, shown in the admin portal.
let instagramAccount = null;

// ---------- Email ----------

function mailSettings() {
  const smtpUser = settings.get('smtpUser');
  return {
    host: settings.get('smtpHost'),
    port: settings.get('smtpPort'),
    user: smtpUser,
    pass: settings.get('smtpPass'),
    to: settings.get('mailTo') || smtpUser,
    from: settings.get('mailFrom') || smtpUser,
  };
}

let mailerCache = { signature: null, mailer: null };

// Rebuilt whenever the email settings change, so updates from the admin portal apply immediately.
function getMailer() {
  const m = mailSettings();
  if (!(m.host && m.user && m.pass && m.to)) return null;
  const signature = sha256(JSON.stringify([m.host, m.port, m.user, m.pass]));
  if (mailerCache.signature !== signature) {
    mailerCache = {
      signature,
      mailer: nodemailer.createTransport({
        host: m.host,
        port: m.port,
        secure: m.port === 465,
        auth: { user: m.user, pass: m.pass },
        // Fail fast so the browser gets an answer instead of hanging until Cloudflare times out.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      }),
    };
  }
  return mailerCache.mailer;
}

// ---------- Instagram ----------

// The token file is encrypted when ADMIN_ENCRYPTION_KEY is set. Older plain-text files are still read.
async function readTokenState() {
  let saved;
  try {
    saved = JSON.parse(await fsp.readFile(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (saved.tokenEnc) {
    if (!ENCRYPTION_KEY) return null;
    try {
      return { token: decrypt(ENCRYPTION_KEY, saved.tokenEnc, 'instagram-token'), seedHash: saved.seedHash, refreshedAt: saved.refreshedAt };
    } catch {
      log('Saved Instagram token could not be decrypted; using the configured token instead.');
      return null;
    }
  }
  if (saved.token) return { token: saved.token, seedHash: saved.seed ? sha256(saved.seed) : saved.seedHash, refreshedAt: saved.refreshedAt, legacy: true };
  return null;
}

async function writeTokenState(state) {
  const body = ENCRYPTION_KEY
    ? { tokenEnc: encrypt(ENCRYPTION_KEY, state.token, 'instagram-token'), seedHash: state.seedHash, refreshedAt: state.refreshedAt }
    : { token: state.token, seedHash: state.seedHash, refreshedAt: state.refreshedAt };
  await writeJson(TOKEN_FILE, body);
}

async function loadToken() {
  const configured = settings.get('instagramToken');
  const saved = await readTokenState();
  // A newly configured token (from .env or the admin portal) replaces the saved one.
  if (configured && (!saved || saved.seedHash !== sha256(configured))) {
    const fresh = { token: configured, seedHash: sha256(configured), refreshedAt: Date.now() };
    await writeTokenState(fresh);
    return fresh;
  }
  if (!configured) return null;
  if (saved && saved.legacy && ENCRYPTION_KEY) await writeTokenState(saved);
  return saved && saved.token ? saved : null;
}

// Instagram Login tokens expire after 60 days unless refreshed. Business tokens are not refreshed.
async function refreshTokenIfDue(state) {
  if (tokenKind(state.token) === 'business') return state;
  if (Date.now() - state.refreshedAt < TOKEN_REFRESH_DAYS * DAY_MS) return state;
  let fresh;
  try {
    fresh = await instagram.refresh(state.token);
  } catch (err) {
    log('Instagram token refresh failed:', err.message);
    return state;
  }
  const next = { ...state, token: fresh.token, refreshedAt: Date.now() };
  await writeTokenState(next);
  log('Instagram token refreshed. Valid for about', Math.round((fresh.expiresIn || 0) / 86400), 'days.');
  return next;
}

function extensionFor(contentType) {
  if (/png/i.test(contentType)) return '.png';
  if (/webp/i.test(contentType)) return '.webp';
  return '.jpg';
}

async function downloadImage(id, imageUrl, previous) {
  if (previous && previous.file && fs.existsSync(path.join(MEDIA_DIR, previous.file))) {
    return previous.file;
  }
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`image download failed with HTTP ${res.status}`);
  const file = `${id}${extensionFor(res.headers.get('content-type') || '')}`;
  await fsp.writeFile(path.join(MEDIA_DIR, file), Buffer.from(await res.arrayBuffer()));
  return file;
}

async function refreshInstagram() {
  let state = await loadToken();
  if (!state) {
    lastErrors.instagram = null;
    instagramAccount = null;
    log('Instagram is not configured (no access token). The site will use gallery.json.');
    return;
  }
  state = await refreshTokenIfDue(state);

  const accountId = settings.get('instagramAccountId');
  let posts;
  try {
    const key = sha256(`${state.token}\n${accountId || ''}`);
    if (!instagramAccount || instagramAccount.key !== key) {
      instagramAccount = { ...(await instagram.account(state.token, accountId)), key };
    }
    posts = await instagram.media(state.token, { limit: settings.get('instagramPostLimit'), accountId });
  } catch (err) {
    lastErrors.instagram = { at: new Date().toISOString(), message: err.message };
    log('Instagram fetch failed:', err.message);
    return;
  }

  const previousById = new Map(feed.items.map((item) => [item.id, item]));
  const items = [];
  for (const post of posts) {
    if (!/^[A-Za-z0-9_]+$/.test(String(post.id))) continue;
    const imageUrl = post.media_type === 'VIDEO' ? post.thumbnail_url : post.media_url;
    if (!imageUrl) continue;
    try {
      const file = await downloadImage(post.id, imageUrl, previousById.get(post.id));
      items.push({
        id: post.id,
        file,
        image: `/ig/${file}`,
        caption: (post.caption || '').slice(0, 500),
        permalink: post.permalink || '',
        timestamp: post.timestamp || null,
        isVideo: post.media_type === 'VIDEO',
      });
    } catch (err) {
      log(`Skipping Instagram post ${post.id}:`, err.message);
    }
  }

  feed = { items, updatedAt: new Date().toISOString() };
  lastErrors.instagram = null;
  await writeJson(FEED_FILE, feed, 0o644);

  const keep = new Set(items.map((item) => item.file).concat('feed.json'));
  for (const name of await fsp.readdir(MEDIA_DIR)) {
    if (!keep.has(name) && !name.endsWith('.tmp')) await fsp.rm(path.join(MEDIA_DIR, name), { force: true });
  }
  log(`Instagram gallery updated with ${items.length} posts.`);
}

let refreshRunning = null;
let refreshAgain = false;
// One refresh at a time. A request made while one is running (for example a new token saved in the
// portal) runs again afterwards, so it always uses the latest settings.
function runInstagramRefresh() {
  if (refreshRunning) {
    refreshAgain = true;
    return refreshRunning;
  }
  refreshRunning = refreshInstagram()
    .catch((err) => {
      lastErrors.instagram = { at: new Date().toISOString(), message: err.message };
      log('Instagram refresh error:', err.message);
    })
    .finally(() => {
      refreshRunning = null;
      if (refreshAgain) {
        refreshAgain = false;
        runInstagramRefresh();
      }
    });
  return refreshRunning;
}

// ---------- Inquiries ----------

function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');
}

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (recentInquiries.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (hits.length >= RATE_LIMIT.max) {
    recentInquiries.set(ip, hits);
    return true;
  }
  hits.push(now);
  recentInquiries.set(ip, hits);
  return false;
}

function cleanInquiry(raw) {
  const data = {};
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    const value = typeof raw[field] === 'string' ? raw[field].trim() : '';
    data[field] = value.slice(0, max);
  }
  const oneLine = (s) => s.replace(/[\r\n\t]+/g, ' ');
  for (const field of ['name', 'email', 'phone', 'eventDate', 'quantity']) data[field] = oneLine(data[field]);

  const errors = [];
  if (!data.name) errors.push('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push('Please enter a valid email address.');
  if (!INQUIRY_TYPES[data.inquiryType]) data.inquiryType = 'general';
  if (data.message.length < 10) errors.push('Please tell us a little more in your message (at least 10 characters).');
  return { data, errors };
}

function inquiryEmailText(d) {
  return [
    `New inquiry from the ${settings.get('siteName')} website`,
    '',
    `Type:        ${INQUIRY_TYPES[d.inquiryType]}`,
    `Name:        ${d.name}`,
    `Email:       ${d.email}`,
    `Phone:       ${d.phone || '(not provided)'}`,
    `Event date:  ${d.eventDate || '(not provided)'}`,
    `Quantity:    ${d.quantity || '(not provided)'}`,
    '',
    'Message:',
    d.message,
    '',
    'Reply to this email to answer the customer directly.',
  ].join('\n');
}

// Emails one inquiry to the bakery. Returns { ok, status, error }.
async function emailInquiry(d) {
  const mailer = getMailer();
  if (!mailer) return { ok: false, status: 'not-configured', error: 'Email is not set up (SMTP settings are empty).' };
  const m = mailSettings();
  try {
    await mailer.sendMail({
      from: { name: `${settings.get('siteName')} Website`, address: m.from },
      to: m.to,
      replyTo: { name: d.name, address: d.email },
      subject: `New ${(INQUIRY_TYPES[d.inquiryType] || INQUIRY_TYPES.general).toLowerCase()} inquiry from ${d.name}`,
      text: inquiryEmailText(d),
    });
    lastErrors.email = null;
    return { ok: true, status: 'sent' };
  } catch (err) {
    lastErrors.email = { at: new Date().toISOString(), message: err.message };
    return { ok: false, status: 'failed', error: err.message };
  }
}

async function handleInquiry(req, res) {
  if (!/application\/json/i.test(req.headers['content-type'] || '')) {
    return sendJson(res, 415, { ok: false, error: 'Expected JSON.' });
  }
  let raw;
  try {
    raw = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: 'Invalid request.' });
  }
  if (!raw || typeof raw !== 'object') return sendJson(res, 400, { ok: false, error: 'Invalid request.' });

  const { data, errors } = cleanInquiry(raw);
  const trapped = TRAP_FIELDS.some((field) => data[field]);
  for (const field of TRAP_FIELDS) delete data[field];
  if (errors.length) return sendJson(res, 400, { ok: false, error: errors.join(' ') });
  if (isRateLimited(clientIp(req))) {
    return sendJson(res, 429, { ok: false, error: 'Too many messages. Please try again later.' });
  }
  // Hidden spam-trap field: bots usually fill it in. Keep a flagged copy in the admin portal's
  // Spam folder instead of dropping it, in case a browser autofilled it for a real visitor.
  if (trapped) {
    await inquiries.add(data, { spam: true, delivery: 'skipped' });
    log('Inquiry flagged as spam (trap field filled), not emailed:', data.name, data.email);
    return sendJson(res, 200, { ok: true });
  }

  // Saved first, so no inquiry is lost if email fails. It shows in the admin portal's Inbox.
  const saved = await inquiries.add(data, { delivery: 'pending' });
  const result = await emailInquiry(data);
  await inquiries.update(saved.id, { delivery: { status: result.status, error: result.error } });

  if (result.ok) {
    log('Inquiry emailed:', data.inquiryType);
    return sendJson(res, 200, { ok: true });
  }
  if (result.status === 'not-configured') {
    log('Inquiry saved but email is not configured (SMTP settings are empty):', data.name, data.email);
    if (DEV) return sendJson(res, 200, { ok: true });
    return sendJson(res, 503, { ok: false, error: 'Our contact form is not set up yet. Please message us on Instagram.' });
  }
  log('Inquiry email failed:', result.error);
  return sendJson(res, 502, { ok: false, error: 'We could not send your message right now. Please try again later or message us on Instagram.' });
}

// Admin portal: email a saved inquiry again (after a failure, or one rescued from Spam).
async function resendInquiry(id) {
  const entry = inquiries.get(id);
  if (!entry) return { ok: false, status: 404, error: 'That inquiry no longer exists.' };
  const result = await emailInquiry(entry);
  const updated = await inquiries.update(id, { delivery: { status: result.status, error: result.error } });
  if (!result.ok) return { ok: false, status: 502, error: `Sending failed: ${result.error}`, inquiry: updated };
  return { ok: true, inquiry: updated, message: `Emailed to ${mailSettings().to}.` };
}

// ---------- Admin portal helpers ----------

async function getStatus() {
  const m = mailSettings();
  const token = settings.get('instagramToken');
  const saved = token ? await readTokenState().catch(() => null) : null;
  const kind = token ? tokenKind(token) : null;
  return {
    siteName: settings.get('siteName'),
    email: { configured: Boolean(getMailer()), sendTo: m.to || null, lastError: lastErrors.email },
    instagram: {
      configured: Boolean(token), posts: feed.items.length, updatedAt: feed.updatedAt, lastError: lastErrors.instagram,
      kind, account: instagramAccount ? instagramAccount.username : null,
      // Instagram Login tokens are renewed weekly; each renewal lasts 60 days.
      tokenRenewedAt: kind === 'instagram' && saved && saved.refreshedAt ? new Date(saved.refreshedAt).toISOString() : null,
    },
    inquiries: inquiries.counts(),
  };
}

async function testEmail() {
  const mailer = getMailer();
  if (!mailer) return { ok: false, message: 'Email is not configured. Fill in the SMTP server, username, password and recipient.' };
  const m = mailSettings();
  try {
    await mailer.sendMail({
      from: { name: `${settings.get('siteName')} Website`, address: m.from },
      to: m.to,
      subject: `Test email from the ${settings.get('siteName')} admin portal`,
      text: 'This is a test message from the website admin portal. If you can read this, inquiry emails are working.',
    });
    lastErrors.email = null;
    return { ok: true, message: `Test email sent to ${m.to}. Check that inbox (and Spam).` };
  } catch (err) {
    lastErrors.email = { at: new Date().toISOString(), message: err.message };
    return { ok: false, message: `Sending failed: ${err.message}` };
  }
}

async function testInstagram() {
  const state = await loadToken().catch(() => null);
  if (!state) return { ok: false, message: 'No Instagram access token is configured.' };
  const kind = tokenKind(state.token);
  try {
    instagram.forget();
    const accountId = settings.get('instagramAccountId');
    const found = await instagram.account(state.token, accountId);
    instagramAccount = { ...found, key: sha256(`${state.token}\n${accountId || ''}`) };
    runInstagramRefresh();
    const how = kind === 'business' ? 'a business (Facebook login) token' : 'an Instagram login token';
    return { ok: true, message: `Connected to @${found.username || found.id} with ${how}. The gallery is refreshing now.` };
  } catch (err) {
    return { ok: false, message: `Instagram connection failed: ${err.message}` };
  }
}

// ---------- HTTP plumbing ----------

function readBody(req, limit = MAX_BODY_BYTES) {
  return readBodyBuffer(req, limit).then((buffer) => buffer.toString('utf8'));
}

function readBodyBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      const err = new Error('Body too large');
      err.code = 'TOO_LARGE';
      reject(err);
      req.resume();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('Body too large');
        err.code = 'TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const adminRoutes = createAdminRoutes({
  auth, settings, audit, readBody, readBodyBuffer, sendJson, clientIp, keyConfigured: Boolean(ENCRYPTION_KEY),
  getStatus, testEmail, testInstagram, inquiries, resendInquiry, content, media, backups,
  // The preview links its draft design through an admin-only URL; the published files are untouched.
  renderPreview: () => {
    const draft = content.preview();
    const css = themeCss(draft.theme);
    const assets = css ? { themeHref: `/api/admin/content/preview-theme.css?v=${sha256(css).slice(0, 12)}` } : {};
    return renderPage(draft, { preview: true, photos: media.lookup(), assets });
  },
  previewThemeCss: () => themeCss(content.preview().theme) || '',
});

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

// Local preview only: on the server, nginx serves these files instead.
async function serveStatic(pathname, res) {
  if (pathname === '/admin') {
    res.writeHead(301, { Location: '/admin/' });
    return res.end();
  }
  let root = STATIC_DIR;
  let relative = decodeURIComponent(pathname);
  if (relative.startsWith('/ig/')) {
    root = MEDIA_DIR;
    relative = relative.slice(3);
  } else if (relative.startsWith('/uploads/')) {
    root = UPLOAD_DIR;
    relative = relative.slice('/uploads'.length);
  } else if (relative.startsWith('/site-assets/')) {
    root = SITE_ASSETS_DIR;
    relative = relative.slice('/site-assets'.length);
  }
  // Mirror nginx: a page published from the admin portal replaces site/index.html.
  if ((relative === '/' || relative === '/index.html') && fs.existsSync(content.pageFile)) {
    root = PUBLISHED_SITE_DIR;
    relative = '/index.html';
  }
  if (relative.endsWith('/')) relative += 'index.html';
  const file = path.resolve(root, '.' + relative);
  if (file !== root && !file.startsWith(root + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const content = await fsp.readFile(file);
    const headers = { 'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' };
    if (pathname.startsWith('/admin/')) headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, instagramPosts: feed.items.length, email: Boolean(getMailer()) });
    }
    if (pathname === '/api/instagram' && req.method === 'GET') {
      return sendJson(res, 200, { items: feed.items.map(({ file, ...item }) => item), updatedAt: feed.updatedAt });
    }
    if (pathname === '/api/inquiry' && req.method === 'POST') return await handleInquiry(req, res);
    if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) return await adminRoutes.handle(req, res, pathname);
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (DEV && req.method === 'GET') return await serveStatic(pathname, res);
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    log('Unexpected error:', err.message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Something went wrong.' });
  }
});

let timers = [];

// Loads saved data. Separate from start() so tests can run the server without the Instagram timer.
async function init() {
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  await ensurePrivateDir(ADMIN_DIR);
  await settings.load();
  await auth.load();
  await media.load();
  await content.load();
  await content.regenerate();
  await inquiries.load();
  try {
    feed = JSON.parse(await fsp.readFile(FEED_FILE, 'utf8'));
  } catch {
    // First start: no cached feed yet.
  }
  settings.onChange((changed) => {
    if (changed.includes('instagramToken') || changed.includes('instagramAccountId')) {
      instagram.forget();
      instagramAccount = null;
    }
    if (['instagramToken', 'instagramPostLimit', 'instagramAccountId'].some((name) => changed.includes(name))) runInstagramRefresh();
  });
}

async function start() {
  await init();
  await new Promise((resolve) => server.listen(PORT, resolve));
  log(`${settings.get('siteName')} API listening on port ${PORT}${DEV ? ` (preview mode: open http://localhost:${PORT})` : ''}`);
  log(`Email ${getMailer() ? 'is configured' : 'is NOT configured'}.`);
  if (ENCRYPTION_KEY) {
    log(`Admin portal ${auth.hasUsers() ? 'is ready' : 'has no admin users yet (run: node scripts/create-admin.js)'}.`);
  } else {
    log('Admin portal is disabled: ADMIN_ENCRYPTION_KEY is not set.');
  }
  for (const problem of settings.problems()) log('Settings warning:', problem);

  runInstagramRefresh();
  timers = [
    setInterval(runInstagramRefresh, IG_REFRESH_MINUTES * 60 * 1000),
    setInterval(() => {
      const now = Date.now();
      for (const [ip, hits] of recentInquiries) {
        if (hits.every((t) => now - t >= RATE_LIMIT.windowMs)) recentInquiries.delete(ip);
      }
    }, RATE_LIMIT.windowMs),
    setInterval(() => auth.sweep().catch((err) => log('Session cleanup error:', err.message)), 5 * 60 * 1000),
    setInterval(() => inquiries.prune().catch((err) => log('Inquiry clean-up error:', err.message)), DAY_MS),
  ];
  for (const timer of timers) timer.unref();
}

module.exports = { server, init, auth, settings, content, media, inquiries, backups, DATA_DIR };

if (require.main === module) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
