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

test('page content: draft, preview, publish', async () => {
  const anonymous = await request('/api/admin/content');
  assert.equal(anonymous.status, 401);
  assert.equal((await request('/api/admin/content/preview')).status, 401);

  const { cookie, csrf } = await signIn('10.3.0.1');
  const loaded = await (await request('/api/admin/content', { cookie })).json();
  assert.equal(loaded.published, null);
  const draft = loaded.draft;
  draft.hero.heading = 'Fresh <cupcakes> daily';

  assert.equal((await request('/api/admin/content', { method: 'PUT', cookie, body: { content: draft, revision: loaded.revision } })).status, 403);
  const saved = await request('/api/admin/content', { method: 'PUT', cookie, csrf, body: { content: draft, revision: loaded.revision } });
  assert.equal(saved.status, 200);
  const afterSave = await saved.json();
  assert.equal(afterSave.hasUnpublishedChanges, true);

  const stale = await request('/api/admin/content', { method: 'PUT', cookie, csrf, body: { content: draft, revision: loaded.revision } });
  assert.equal(stale.status, 409);

  const preview = await request('/api/admin/content/preview', { cookie });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type'), /text\/html/);
  const previewHtml = await preview.text();
  assert.ok(previewHtml.includes('Fresh &lt;cupcakes&gt; daily') && previewHtml.includes('data-preview="1"'));

  const pageFile = path.join(dataDir, 'site', 'index.html');
  assert.equal(fs.existsSync(pageFile), false);
  assert.equal((await request('/api/admin/content/publish', { method: 'POST', cookie, csrf, body: { revision: afterSave.revision - 1 } })).status, 409);
  const published = await request('/api/admin/content/publish', { method: 'POST', cookie, csrf, body: { revision: afterSave.revision } });
  assert.equal(published.status, 200);
  const live = fs.readFileSync(pageFile, 'utf8');
  assert.ok(live.includes('Fresh &lt;cupcakes&gt; daily') && !live.includes('data-preview'));
  const body = await published.json();
  assert.equal(body.hasUnpublishedChanges, false);
  assert.deepEqual(body.history.map((h) => h.label), ['published', 'original']);
});

test('photos: upload, describe, use on the page, delete only when unused', async () => {
  const sharp = require('sharp');
  const jpeg = await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#a8d5ba' } })
    .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '47/1 36/1 22/1' } }).jpeg().toBuffer();
  const upload = (headers) => fetch(`${base}/api/admin/media`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...headers }, body: jpeg });

  assert.equal((await upload({})).status, 401);
  const { cookie, csrf } = await signIn('10.4.0.1');
  assert.equal((await upload({ Cookie: cookie })).status, 403, 'CSRF token required');
  const notImage = await fetch(`${base}/api/admin/media`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'image/jpeg' }, body: 'not a photo' });
  assert.equal(notImage.status, 400);

  const res = await upload({ Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Photo-Description': encodeURIComponent('Mint cupcakes') });
  assert.equal(res.status, 200);
  const { photo } = await res.json();
  assert.equal(photo.alt, 'Mint cupcakes');
  assert.deepEqual(photo.usedIn, []);
  const stored = fs.readFileSync(path.join(dataDir, 'uploads', `${photo.id}-800.webp`));
  assert.equal((await sharp(stored).metadata()).exif, undefined, 'GPS data removed');

  const list = await (await request('/api/admin/media', { cookie })).json();
  assert.ok(list.photos.some((p) => p.id === photo.id));

  const loaded = await (await request('/api/admin/content', { cookie })).json();
  loaded.draft.gallery.photos = [photo.id];
  const saved = await request('/api/admin/content', { method: 'PUT', cookie, csrf, body: { content: loaded.draft, revision: loaded.revision } });
  assert.equal(saved.status, 200);

  const blocked = await request(`/api/admin/media/${photo.id}`, { method: 'DELETE', cookie, csrf });
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /Gallery/);
  const cleared = await request(`/api/admin/media/${photo.id}`, { method: 'PUT', cookie, csrf, body: { alt: '' } });
  assert.equal(cleared.status, 400, 'a photo in use must keep a description');
  const invisible = await request(`/api/admin/media/${photo.id}`, { method: 'PUT', cookie, csrf, body: { alt: ' \u0001\u0002 ' } });
  assert.equal(invisible.status, 400, 'invisible characters do not count as a description');
  const described = await request(`/api/admin/media/${photo.id}`, { method: 'PUT', cookie, csrf, body: { alt: 'Mint chip cupcakes' } });
  assert.equal((await described.json()).photo.alt, 'Mint chip cupcakes');

  const preview = await (await request('/api/admin/content/preview', { cookie })).text();
  assert.ok(preview.includes(`/uploads/${photo.id}-400.webp`) && preview.includes('alt="Mint chip cupcakes"'));

  const current = await (await request('/api/admin/content', { cookie })).json();
  current.draft.gallery.photos = [];
  await request('/api/admin/content', { method: 'PUT', cookie, csrf, body: { content: current.draft, revision: current.revision } });
  const removed = await request(`/api/admin/media/${photo.id}`, { method: 'DELETE', cookie, csrf });
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'uploads', `${photo.id}-800.webp`)), false);
  assert.equal((await request(`/api/admin/media/${photo.id}`, { method: 'DELETE', cookie, csrf })).status, 404);
  assert.equal((await request('/api/admin/media/..%2F..%2Fadmin', { method: 'DELETE', cookie, csrf })).status, 404);
});

test('a photo never goes live without a description, even when edits race', async () => {
  const sharp = require('sharp');
  const { cookie, csrf } = await signIn('10.5.0.1');
  for (let run = 0; run < 6; run += 1) {
    const jpeg = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#fbe38e' } }).jpeg().toBuffer();
    const up = await fetch(`${base}/api/admin/media`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'image/jpeg', 'X-Photo-Description': 'Lemon' }, body: jpeg });
    const { photo } = await up.json();
    const clearDescription = request(`/api/admin/media/${photo.id}`, { method: 'PUT', cookie, csrf, body: { alt: '' } });
    const useAndPublish = (async () => {
      const loaded = await (await request('/api/admin/content', { cookie })).json();
      loaded.draft.hero.image = photo.id;
      const saved = await (await request('/api/admin/content', { method: 'PUT', cookie, csrf, body: { content: loaded.draft, revision: loaded.revision } })).json();
      if (!saved.ok) return;
      await request('/api/admin/content/publish', { method: 'POST', cookie, csrf, body: { revision: saved.revision } });
    })();
    await Promise.all([clearDescription, useAndPublish]);
    const live = fs.readFileSync(path.join(dataDir, 'site', 'index.html'), 'utf8');
    if (live.includes(`/uploads/${photo.id}-`)) {
      assert.ok(!/class="hero-photo"[^>]*alt=""/.test(live), `run ${run}: live photo has an empty description`);
    }
  }
});

test('design: the preview stylesheet is private and follows the draft', async () => {
  assert.equal((await request('/api/admin/content/preview-theme.css')).status, 401);
  const { cookie, csrf } = await signIn('10.6.0.1');
  const loaded = await (await request('/api/admin/content', { cookie })).json();
  assert.ok(loaded.design.presets.length >= 5 && loaded.design.headingFonts.some((f) => f.key === 'playfair'));
  loaded.draft.theme.colors = { ...loaded.design.presets.find((p) => p.key === 'lavender').colors };
  loaded.draft.theme.headingFont = 'pacifico';
  const saved = await request('/api/admin/content', { method: 'PUT', cookie, csrf, body: { content: loaded.draft, revision: loaded.revision } });
  assert.equal(saved.status, 200);
  const css = await request('/api/admin/content/preview-theme.css', { cookie });
  assert.match(css.headers.get('content-type'), /text\/css/);
  const cssText = await css.text();
  assert.match(cssText, /--pink-strong: #7b4fb3;/);
  assert.match(cssText, /url\("\/fonts\/pacifico\.woff2"\)/);
  const preview = await (await request('/api/admin/content/preview', { cookie })).text();
  assert.match(preview, /<link rel="stylesheet" href="\/api\/admin\/content\/preview-theme\.css\?v=[0-9a-f]{12}">/);
});

test('the color rules are served to the portal before sign-in, and match the server', async () => {
  const res = await request('/api/admin/palette.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/javascript/);
  assert.equal(await res.text(), fs.readFileSync(path.join(__dirname, '..', 'lib', 'palette.js'), 'utf8'));
});

test('inbox: every inquiry is listed and can be handled, rescued from spam, exported and deleted', async () => {
  const { cookie, csrf } = await signIn('10.7.0.1');
  // Email is not set up for this test, so inquiries are saved without being emailed.
  await request('/api/admin/settings', { method: 'PUT', cookie, csrf, body: { reset: ['smtpHost', 'smtpUser', 'smtpPass', 'mailTo'] } });
  const send = (body, ip) => request('/api/inquiry', { method: 'POST', body: { email: 'c@example.com', inquiryType: 'event', message: 'Party for 30 kids next month', ...body }, ip });
  await send({ name: 'Carla' }, '10.7.1.1');
  await send({ name: 'Autofilled', fh_trap: 'oops' }, '10.7.1.2');
  assert.equal((await request('/api/admin/inquiries')).status, 401);

  const open = await (await request('/api/admin/inquiries?view=open', { cookie })).json();
  const carla = open.items.find((q) => q.name === 'Carla');
  assert.equal(carla.type, 'Event or party');
  assert.equal(carla.delivery.status, 'not-configured');
  assert.ok(open.counts.spam >= 1);
  const spam = (await (await request('/api/admin/inquiries?view=spam', { cookie })).json()).items.find((q) => q.name === 'Autofilled');
  assert.equal(spam.delivery.status, 'skipped');

  assert.equal((await request(`/api/admin/inquiries/${carla.id}`, { method: 'PUT', cookie, body: { handled: true } })).status, 403, 'changes need the CSRF token');
  assert.equal((await request(`/api/admin/inquiries/${carla.id}`, { method: 'PUT', cookie, csrf, body: { handled: 'yes' } })).status, 400);
  const handled = await (await request(`/api/admin/inquiries/${carla.id}`, { method: 'PUT', cookie, csrf, body: { handled: true } })).json();
  assert.equal(handled.inquiry.handled, true);
  assert.equal(handled.inquiry.handledBy, 'derek');

  const rescued = await (await request(`/api/admin/inquiries/${spam.id}`, { method: 'PUT', cookie, csrf, body: { spam: false } })).json();
  assert.equal(rescued.inquiry.spam, false);
  const resend = await request(`/api/admin/inquiries/${spam.id}/resend`, { method: 'POST', cookie, csrf, body: {} });
  assert.equal(resend.status, 502);
  assert.match((await resend.json()).error, /Email is not set up/);

  const search = await (await request('/api/admin/inquiries?view=all&q=carla', { cookie })).json();
  assert.deepEqual(search.items.map((q) => q.name), ['Carla']);

  const csv = await request('/api/admin/inquiries/export.csv?view=all', { cookie });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="inquiries-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.match(await csv.text(), /"Carla","c@example.com"/);

  assert.equal((await request(`/api/admin/inquiries/${carla.id}`, { method: 'DELETE', cookie, csrf })).status, 200);
  assert.equal((await request(`/api/admin/inquiries/${carla.id}`, { method: 'PUT', cookie, csrf, body: { handled: false } })).status, 404);
  assert.equal((await request('/api/admin/inquiries/not-an-id', { cookie })).status, 404);

  const dashboard = await (await request('/api/admin/dashboard', { cookie })).json();
  assert.ok(dashboard.status.inquiries.all >= 1);
  assert.ok(!dashboard.inquiries.some((q) => q.name === 'Carla'));
  const log = fs.readFileSync(path.join(dataDir, 'admin', 'audit.log'), 'utf8');
  assert.match(log, /"action":"inquiry-handled"/);
  assert.match(log, /"action":"inquiries-exported"/);
  assert.ok(!log.includes('Party for 30 kids'), 'the audit log does not copy customer messages');
});

test('the Instagram account ID setting only accepts digits', async () => {
  const { cookie, csrf } = await signIn('10.8.0.1');
  const bad = await request('/api/admin/settings', { method: 'PUT', cookie, csrf, body: { changes: { instagramAccountId: '../me' } } });
  assert.equal(bad.status, 400);
  const good = await request('/api/admin/settings', { method: 'PUT', cookie, csrf, body: { changes: { instagramAccountId: '17841400000000001' } } });
  assert.equal(good.status, 200);
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

// ---------- Phase 5: roles, admins, backups, two-step sign-in ----------

const totp = require('../lib/totp');

test('editors manage content, photos and inquiries, but not settings, admins or backups', async () => {
  await app.auth.createUser('baker', 'editor test password', { role: 'editor' });
  const res = await request('/api/admin/login', { method: 'POST', body: { username: 'baker', password: 'editor test password' }, ip: '10.10.0.1' });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { csrf, user } = await res.json();
  assert.equal(user.role, 'editor');
  for (const pathname of ['/api/admin/settings', '/api/admin/users', '/api/admin/backup', '/api/admin/backup/automatic']) {
    assert.equal((await request(pathname, { cookie })).status, 403, pathname);
  }
  assert.equal((await request('/api/admin/test/email', { method: 'POST', cookie, csrf, body: {} })).status, 403);
  assert.equal((await request('/api/admin/backup/restore', { method: 'POST', cookie, csrf, body: {} })).status, 403);
  for (const pathname of ['/api/admin/content', '/api/admin/inquiries', '/api/admin/media', '/api/admin/dashboard']) {
    assert.equal((await request(pathname, { cookie })).status, 200, pathname);
  }
});

test('owners manage admins, always confirming with their own password', async () => {
  const { cookie, csrf } = await signIn('10.11.0.1');
  const list = await (await request('/api/admin/users', { cookie })).json();
  const me = list.users.find((u) => u.you);
  const baker = list.users.find((u) => u.username === 'baker');
  assert.equal(me.username, 'derek');
  assert.ok(!JSON.stringify(list).includes('passwordHash'));

  const body = { username: 'helper', password: 'helper test password', role: 'editor' };
  assert.equal((await request('/api/admin/users', { method: 'POST', cookie, csrf, body })).status, 400, 'needs the password');
  assert.equal((await request('/api/admin/users', { method: 'POST', cookie, csrf, body: { ...body, confirmPassword: 'wrong' } })).status, 400);
  const added = await (await request('/api/admin/users', { method: 'POST', cookie, csrf, body: { ...body, confirmPassword: PASSWORD } })).json();
  const helper = added.users.find((u) => u.username === 'helper');
  assert.equal(helper.role, 'editor');

  assert.equal((await request(`/api/admin/users/${me.id}/remove`, { method: 'POST', cookie, csrf, body: { confirmPassword: PASSWORD } })).status, 400, 'not yourself');
  assert.equal((await request(`/api/admin/users/${me.id}`, { method: 'PUT', cookie, csrf, body: { role: 'editor', confirmPassword: PASSWORD } })).status, 400, 'the last owner stays an owner');
  const promoted = await (await request(`/api/admin/users/${baker.id}`, { method: 'PUT', cookie, csrf, body: { role: 'owner', confirmPassword: PASSWORD } })).json();
  assert.equal(promoted.users.find((u) => u.username === 'baker').role, 'owner');
  await request(`/api/admin/users/${baker.id}`, { method: 'PUT', cookie, csrf, body: { role: 'editor', confirmPassword: PASSWORD } });
  const reset = await request(`/api/admin/users/${helper.id}/password`, { method: 'POST', cookie, csrf, body: { password: 'new helper password', confirmPassword: PASSWORD } });
  assert.equal(reset.status, 200);
  const removed = await (await request(`/api/admin/users/${helper.id}/remove`, { method: 'POST', cookie, csrf, body: { confirmPassword: PASSWORD } })).json();
  assert.ok(!removed.users.some((u) => u.username === 'helper'));
  const log = fs.readFileSync(path.join(dataDir, 'admin', 'audit.log'), 'utf8');
  assert.match(log, /"action":"admin-added"/);
  assert.match(log, /"action":"admin-removed"/);
  assert.ok(!log.includes('helper test password') && !log.includes('new helper password'));
});

test('backup: download, change things, restore puts them back and keeps an automatic backup', async () => {
  const { cookie, csrf } = await signIn('10.12.0.1');
  await request('/api/admin/settings', { method: 'PUT', cookie, csrf, body: { changes: { siteName: 'Before Backup Bakery' } } });
  const loaded = await (await request('/api/admin/content', { cookie })).json();
  loaded.draft.hero.heading = 'Heading in the backup';
  await request('/api/admin/content', { method: 'PUT', cookie, csrf, body: { content: loaded.draft, revision: loaded.revision } });
  await request('/api/inquiry', { method: 'POST', body: { name: 'Backed Up', email: 'b@example.com', message: 'Inquiry inside the backup' }, ip: '10.12.1.1' });

  const download = await request('/api/admin/backup', { cookie });
  assert.match(download.headers.get('content-disposition'), /attachment; filename="frosted-harmony-backup-\d{4}-\d{2}-\d{2}\.json"/);
  const backup = await download.json();
  assert.equal(backup.format, 'frosted-harmony-backup');
  assert.ok(!JSON.stringify(backup).includes('users.json') && !JSON.stringify(backup).includes('passwordHash'), 'no admin accounts');

  await request('/api/admin/settings', { method: 'PUT', cookie, csrf, body: { changes: { siteName: 'After Backup Bakery' } } });
  const later = await (await request('/api/admin/content', { cookie })).json();
  later.draft.hero.heading = 'Changed after the backup';
  await request('/api/admin/content', { method: 'PUT', cookie, csrf, body: { content: later.draft, revision: later.revision } });
  await request('/api/inquiry', { method: 'POST', body: { name: 'After', email: 'a@example.com', message: 'Inquiry after the backup' }, ip: '10.12.1.2' });

  const tampered = JSON.parse(JSON.stringify(backup));
  tampered.contents.content.draft.content.hero.heading = 'Edited by hand';
  const refused = await request('/api/admin/backup/restore', { method: 'POST', cookie, csrf, body: { password: PASSWORD, backup: tampered } });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /damaged or was edited/);
  assert.equal((await request('/api/admin/backup/restore', { method: 'POST', cookie, csrf, body: { password: 'wrong', backup } })).status, 400);
  assert.equal((await request('/api/admin/backup/restore', { method: 'POST', cookie, csrf, body: { password: PASSWORD, backup: { format: 'other' } } })).status, 400);

  const restored = await (await request('/api/admin/backup/restore', { method: 'POST', cookie, csrf, body: { password: PASSWORD, backup } })).json();
  assert.equal(restored.ok, true, JSON.stringify(restored));
  const after = await (await request('/api/admin/content', { cookie })).json();
  assert.equal(after.draft.hero.heading, 'Heading in the backup');
  assert.ok(after.revision > later.revision, 'open editors must reload');
  const names = (await (await request('/api/admin/settings', { cookie })).json()).settings;
  assert.equal(names.find((s) => s.name === 'siteName').value, 'Before Backup Bakery');
  const all = await (await request('/api/admin/inquiries?view=all&q=backup', { cookie })).json();
  assert.ok(all.items.some((q) => q.name === 'Backed Up'));
  assert.ok(!all.items.some((q) => q.name === 'After'));

  const automatic = await (await request('/api/admin/backup/automatic', { cookie })).json();
  assert.equal(automatic.backups.length, 1);
  const undo = await request(`/api/admin/backup/automatic/${automatic.backups[0].name}`, { cookie });
  const undoBackup = await undo.json();
  assert.equal(undoBackup.contents.content.draft.content.hero.heading, 'Changed after the backup', 'the automatic backup can undo the restore');
  assert.equal((await request('/api/admin/backup/automatic/..%2Fusers.json', { cookie })).status, 404);
  assert.equal((await request('/api/admin/backup/automatic/before-restore-x.json', { cookie })).status, 404);
});

test('two-step sign-in through the portal', async () => {
  const { cookie, csrf } = await signIn('10.13.0.1');
  assert.equal((await request('/api/admin/account/two-factor/start', { method: 'POST', cookie, csrf, body: { password: 'wrong' } })).status, 400);
  const start = await (await request('/api/admin/account/two-factor/start', { method: 'POST', cookie, csrf, body: { password: PASSWORD } })).json();
  assert.match(start.qr, /^data:image\/svg\+xml;base64,/);
  const secret = start.secret.replace(/ /g, '');
  const step = totp.stepAt(Date.now());
  const confirm = await (await request('/api/admin/account/two-factor/confirm', { method: 'POST', cookie, csrf, body: { code: totp.codeAt(secret, step) } })).json();
  assert.equal(confirm.recoveryCodes.length, 10);

  const first = await (await request('/api/admin/login', { method: 'POST', body: { username: 'derek', password: PASSWORD }, ip: '10.13.0.2' })).json();
  assert.equal(first.needsCode, true);
  const wrong = await request('/api/admin/login/code', { method: 'POST', body: { ticket: first.ticket, code: '000000' }, ip: '10.13.0.2' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).restart, false);
  // The next 30-second code: the current one was used to turn it on.
  const done = await request('/api/admin/login/code', { method: 'POST', body: { ticket: first.ticket, code: totp.codeAt(secret, step + 1) }, ip: '10.13.0.2' });
  assert.equal(done.status, 200);
  const newCookie = done.headers.get('set-cookie').split(';')[0];
  const me = await (await request('/api/admin/me', { cookie: newCookie })).json();
  assert.equal(me.twoFactor.enabled, true);
  assert.equal(me.twoFactor.recoveryCodesLeft, 10);

  // Leave the shared test account as it was for any later tests.
  await app.auth.disableTwoFactorFor(me.user.id);
});