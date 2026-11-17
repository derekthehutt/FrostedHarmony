'use strict';

// Small API for the Frosted Harmony website.
//   GET  /api/health     -> health check
//   GET  /api/instagram  -> cached list of recent Instagram posts
//   POST /api/inquiry    -> emails a customer inquiry
// On the Linux server this runs inside Docker behind nginx.
// Run with --dev on your PC to preview the whole site at http://localhost:8080.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const nodemailer = require('nodemailer');

const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT || (DEV ? 8080 : 3000));
const DATA_DIR = path.resolve(process.env.DATA_DIR || (DEV ? path.join(__dirname, '..', '.local-data') : '/data'));
const STATIC_DIR = DEV ? path.resolve(__dirname, '..', 'site') : null;
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const TOKEN_FILE = path.join(DATA_DIR, 'instagram-token.json');
const FEED_FILE = path.join(MEDIA_DIR, 'feed.json');
const INQUIRY_LOG = path.join(DATA_DIR, 'inquiries.jsonl');

const SITE_NAME = process.env.SITE_NAME || 'Frosted Harmony';
const IG_LIMIT = clampInt(process.env.INSTAGRAM_POST_LIMIT, 12, 1, 50);
const IG_REFRESH_MINUTES = clampInt(process.env.INSTAGRAM_REFRESH_MINUTES, 60, 10, 1440);
const TOKEN_REFRESH_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = clampInt(process.env.SMTP_PORT, 465, 1, 65535);
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
const MAIL_TO = (process.env.MAIL_TO || SMTP_USER).trim();
const MAIL_FROM = (process.env.MAIL_FROM || SMTP_USER).trim();
const mailer = SMTP_HOST && SMTP_USER && SMTP_PASS && MAIL_TO
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Fail fast so the browser gets an answer instead of hanging until Cloudflare times out.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    })
  : null;

const INQUIRY_TYPES = {
  pricing: 'Pricing',
  'custom-order': 'Custom order',
  event: 'Event or party',
  general: 'General question',
};
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

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

// ---------- Instagram ----------

async function loadToken() {
  const envToken = (process.env.INSTAGRAM_ACCESS_TOKEN || '').trim();
  let saved = null;
  try {
    saved = JSON.parse(await fsp.readFile(TOKEN_FILE, 'utf8'));
  } catch {
    // No saved token yet.
  }
  // A new token pasted into .env replaces the saved one.
  if (envToken && (!saved || saved.seed !== envToken)) {
    const fresh = { token: envToken, seed: envToken, refreshedAt: Date.now() };
    await writeJsonAtomic(TOKEN_FILE, fresh);
    return fresh;
  }
  return saved && saved.token ? saved : null;
}

// Long-lived Instagram tokens expire after 60 days unless refreshed.
async function refreshTokenIfDue(state) {
  if (Date.now() - state.refreshedAt < TOKEN_REFRESH_DAYS * DAY_MS) return state;
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', state.token);
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    log('Instagram token refresh failed:', res.status, body.error ? body.error.message : '');
    return state;
  }
  const next = { ...state, token: body.access_token, refreshedAt: Date.now() };
  await writeJsonAtomic(TOKEN_FILE, next);
  log('Instagram token refreshed. Valid for about', Math.round((body.expires_in || 0) / 86400), 'days.');
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
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`image download failed with HTTP ${res.status}`);
  const file = `${id}${extensionFor(res.headers.get('content-type') || '')}`;
  await fsp.writeFile(path.join(MEDIA_DIR, file), Buffer.from(await res.arrayBuffer()));
  return file;
}

async function refreshInstagram() {
  let state = await loadToken();
  if (!state) {
    log('Instagram is not configured (INSTAGRAM_ACCESS_TOKEN is empty). The site will use gallery.json.');
    return;
  }
  state = await refreshTokenIfDue(state);

  const url = new URL('https://graph.instagram.com/me/media');
  url.searchParams.set('fields', 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp');
  url.searchParams.set('limit', String(IG_LIMIT));
  url.searchParams.set('access_token', state.token);
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(body.data)) {
    log('Instagram fetch failed:', res.status, body.error ? body.error.message : '');
    return;
  }

  const previousById = new Map(feed.items.map((item) => [item.id, item]));
  const items = [];
  for (const post of body.data) {
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
  await writeJsonAtomic(FEED_FILE, feed);

  const keep = new Set(items.map((item) => item.file).concat('feed.json'));
  for (const name of await fsp.readdir(MEDIA_DIR)) {
    if (!keep.has(name) && !name.endsWith('.tmp')) await fsp.rm(path.join(MEDIA_DIR, name), { force: true });
  }
  log(`Instagram gallery updated with ${items.length} posts.`);
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
    `New inquiry from the ${SITE_NAME} website`,
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
  // Hidden spam-trap field: bots usually fill it in. Keep a flagged copy instead of dropping it,
  // in case a browser autofilled it for a real visitor.
  if (trapped) {
    await fsp.appendFile(INQUIRY_LOG, JSON.stringify({ receivedAt: new Date().toISOString(), spam: true, ...data }) + '\n');
    log('Inquiry flagged as spam (trap field filled), not emailed:', data.name, data.email);
    return sendJson(res, 200, { ok: true });
  }

  // Backup copy so no inquiry is lost if email fails.
  await fsp.appendFile(INQUIRY_LOG, JSON.stringify({ receivedAt: new Date().toISOString(), ...data }) + '\n');

  if (!mailer) {
    log('Inquiry saved but email is not configured (SMTP settings are empty):', data.name, data.email);
    if (DEV) return sendJson(res, 200, { ok: true });
    return sendJson(res, 503, { ok: false, error: 'Our contact form is not set up yet. Please message us on Instagram.' });
  }

  try {
    await mailer.sendMail({
      from: { name: `${SITE_NAME} Website`, address: MAIL_FROM },
      to: MAIL_TO,
      replyTo: { name: data.name, address: data.email },
      subject: `New ${INQUIRY_TYPES[data.inquiryType].toLowerCase()} inquiry from ${data.name}`,
      text: inquiryEmailText(data),
    });
    log('Inquiry emailed:', data.inquiryType);
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    log('Inquiry email failed:', err.message);
    return sendJson(res, 502, { ok: false, error: 'We could not send your message right now. Please try again later or message us on Instagram.' });
  }
}

// ---------- HTTP plumbing ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('Body too large');
        err.code = 'TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

// Local preview only: on the server, nginx serves these files instead.
async function serveStatic(pathname, res) {
  let root = STATIC_DIR;
  let relative = decodeURIComponent(pathname);
  if (relative.startsWith('/ig/')) {
    root = MEDIA_DIR;
    relative = relative.slice(3);
  }
  if (relative.endsWith('/')) relative += 'index.html';
  const file = path.resolve(root, '.' + relative);
  if (file !== root && !file.startsWith(root + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const content = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
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
      return sendJson(res, 200, { ok: true, instagramPosts: feed.items.length, email: Boolean(mailer) });
    }
    if (pathname === '/api/instagram' && req.method === 'GET') {
      return sendJson(res, 200, { items: feed.items.map(({ file, ...item }) => item), updatedAt: feed.updatedAt });
    }
    if (pathname === '/api/inquiry' && req.method === 'POST') return await handleInquiry(req, res);
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (DEV && req.method === 'GET') return await serveStatic(pathname, res);
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    log('Unexpected error:', err.message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Something went wrong.' });
  }
});

async function main() {
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  try {
    feed = JSON.parse(await fsp.readFile(FEED_FILE, 'utf8'));
  } catch {
    // First start: no cached feed yet.
  }

  server.listen(PORT, () => {
    log(`${SITE_NAME} API listening on port ${PORT}${DEV ? ` (preview mode: open http://localhost:${PORT})` : ''}`);
    log(`Email ${mailer ? 'is configured' : 'is NOT configured'}.`);
  });

  const runRefresh = () => refreshInstagram().catch((err) => log('Instagram refresh error:', err.message));
  runRefresh();
  setInterval(runRefresh, IG_REFRESH_MINUTES * 60 * 1000).unref();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, hits] of recentInquiries) {
      if (hits.every((t) => now - t >= RATE_LIMIT.windowMs)) recentInquiries.delete(ip);
    }
  }, RATE_LIMIT.windowMs).unref();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
