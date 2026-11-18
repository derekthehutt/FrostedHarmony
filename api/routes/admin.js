'use strict';

// /api/admin/* routes. Everything except /status and /login requires a signed-in session;
// every change also requires the session's CSRF token and a same-site Origin header.

const ADMIN_BODY_LIMIT = 64 * 1024;
const PHOTO_BODY_LIMIT = 20 * 1024 * 1024;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const theme = require('../lib/theme');
const contentModel = require('../lib/content');
const { renderPage } = require('../lib/render');

// The Design editor's color checks run the same code as the server.
const PALETTE_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'lib', 'palette.js'));
const INQUIRY_ID = /^\/inquiries\/([0-9a-f]{16})(\/resend)?$/;
const USER_ROUTE = /^\/users\/([A-Za-z0-9_-]{12})(?:\/(password|two-factor-off|remove))?$/;
const AUTOMATIC_BACKUP = /^\/backup\/automatic\/([A-Za-z0-9.-]{1,80})$/;
const LIVE_PREVIEW = /^\/content\/live-preview\/([A-Za-z0-9_-]{22})(?:\/([a-z0-9-]*|theme\.css))?$/;
// Backups include every inquiry, so they can be larger than other requests.
const RESTORE_BODY_LIMIT = 30 * 1024 * 1024;
// A page content save holds the whole website (every page and block).
const CONTENT_BODY_LIMIT = 1024 * 1024;
// Live previews of unsaved edits, one per signed-in session, kept in memory for a while.
const PREVIEW_MS = 30 * 60 * 1000;
const PREVIEW_MAX = 50;
// Settings, admin accounts and backups: owners only. Editors manage the page, photos and inbox.
const OWNER_ONLY = [/^\/settings$/, /^\/test\//, /^\/users(\/|$)/, /^\/backup(\/|$)/, /^\/security(\/|$)/];
const QRCode = require('qrcode');

// Choices for the Design editor, sent with the page content so the portal and server always agree.
const DESIGN_OPTIONS = {
  colors: theme.COLOR_KEYS.map((key) => ({ key, label: theme.COLOR_LABELS[key] })),
  presets: Object.entries(theme.PRESETS).map(([key, p]) => ({ key, label: p.label, colors: p.colors })),
  headingFonts: Object.entries(theme.FONTS.heading).map(([key, f]) => ({ key, label: f.label, stack: f.stack, weight: f.weight })),
  bodyFonts: Object.entries(theme.FONTS.body).map(([key, f]) => ({ key, label: f.label, stack: f.stack })),
  corners: Object.entries(theme.CORNERS).map(([key, value]) => ({ key, value })),
  buttons: Object.entries(theme.BUTTONS).map(([key, value]) => ({ key, value })),
  darkModes: Object.entries(theme.DARK_MODES).map(([key, label]) => ({ key, label })),
};
// Block types and limits for the page editor, from the same description the server validates with.
const EDITOR_OPTIONS = {
  blockTypes: contentModel.BLOCK_TYPES_PUBLIC,
  reservedSlugs: contentModel.RESERVED_SLUGS,
  reservedAnchors: contentModel.RESERVED_ANCHORS,
  maxPages: contentModel.MAX_PAGES,
  maxBlocks: contentModel.MAX_BLOCKS,
  maxMenu: contentModel.MAX_MENU,
};
const USERNAME_SHAPE = /^[a-z0-9._-]{1,32}$/i;

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function createAdminRoutes(deps) {
  const { auth, settings, audit, readBody, readBodyBuffer, sendJson, clientIp, keyConfigured, getStatus, testEmail, testInstagram, inquiries, resendInquiry, content, media, backups, vulnerabilities, githubActions } = deps;
  const previews = new Map();

  async function readJsonBody(req, res, limit = ADMIN_BODY_LIMIT) {
    if (!/application\/json/i.test(req.headers['content-type'] || '')) {
      sendJson(res, 415, { ok: false, error: 'Expected JSON.' });
      return null;
    }
    try {
      const body = JSON.parse(await readBody(req, limit));
      if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    } catch (err) {
      sendJson(res, err.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: 'Invalid request.' });
      return null;
    }
    sendJson(res, 400, { ok: false, error: 'Invalid request.' });
    return null;
  }

  const notFound = (res) => sendJson(res, 404, { ok: false, error: 'Not found' });

  async function handleLogin(req, res, ip) {
    if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Request blocked.' });
    const body = await readJsonBody(req, res);
    if (!body) return undefined;
    const result = await auth.login(body.username, body.password, { ip, userAgent: req.headers['user-agent'] });
    if (result.needsCode) {
      // Right password; the sign-in finishes at /login/code with the code from the authenticator app.
      return sendJson(res, 200, { ok: true, needsCode: true, ticket: result.ticket });
    }
    if (!result.ok) {
      const attempted = String(body.username || '').trim();
      await audit.record('login-failed', {
        ip, user: result.username, details: { reason: result.reason, attempted: USERNAME_SHAPE.test(attempted) ? attempted.toLowerCase() : '(invalid)' },
      });
      return sendJson(res, result.status, { ok: false, error: result.error });
    }
    await audit.record('login', { user: result.user.username, ip });
    res.setHeader('Set-Cookie', auth.sessionCookie(result.token));
    return sendJson(res, 200, { ok: true, user: result.user, csrf: result.csrf });
  }

  async function handleLoginCode(req, res, ip) {
    if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Request blocked.' });
    const body = await readJsonBody(req, res);
    if (!body) return undefined;
    const result = await auth.completeLogin(body.ticket, body.code, { ip, userAgent: req.headers['user-agent'] });
    if (!result.ok) {
      await audit.record('login-failed', { ip, user: result.username || null, details: { reason: result.reason, step: 'code' } });
      return sendJson(res, result.status, { ok: false, error: result.error, restart: result.reason !== 'bad-code' });
    }
    await audit.record('login', { user: result.user.username, ip, details: { twoFactor: true, recoveryCode: result.usedRecoveryCode } });
    res.setHeader('Set-Cookie', auth.sessionCookie(result.token));
    return sendJson(res, 200, {
      ok: true, user: result.user, csrf: result.csrf,
      notice: result.usedRecoveryCode ? `You used a recovery code. ${result.recoveryCodesLeft} left: make new ones on the Account tab if you're running low.` : null,
    });
  }

  async function handle(req, res, pathname) {
    const route = pathname.slice('/api/admin'.length) || '/';
    const ip = clientIp(req);
    const method = req.method;

    if (route === '/status' && method === 'GET') {
      await auth.sync();
      return sendJson(res, 200, { ok: true, ready: keyConfigured && auth.hasUsers(), keyConfigured, hasUsers: auth.hasUsers() });
    }
    // Public code with no data in it, needed before signing in.
    if (route === '/palette.js' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(PALETTE_SCRIPT);
    }
    if (!keyConfigured) {
      return sendJson(res, 503, { ok: false, error: 'The admin portal is not set up yet: add ADMIN_ENCRYPTION_KEY to .env on the server.' });
    }
    if (route === '/login') return method === 'POST' ? handleLogin(req, res, ip) : notFound(res);
    if (route === '/login/code') return method === 'POST' ? handleLoginCode(req, res, ip) : notFound(res);

    const current = await auth.authenticate(req.headers.cookie);
    if (!current) {
      res.setHeader('Set-Cookie', auth.clearCookie());
      return sendJson(res, 401, { ok: false, error: 'Please sign in.' });
    }
    const { session, user } = current;
    if (method !== 'GET' && (!sameOrigin(req) || !auth.checkCsrf(session, req.headers['x-csrf-token']))) {
      return sendJson(res, 403, { ok: false, error: 'Your session token is missing or out of date. Reload the page and try again.' });
    }
    const actor = { user: user.username, ip };

    if (user.role !== 'owner' && OWNER_ONLY.some((pattern) => pattern.test(route))) {
      return sendJson(res, 403, { ok: false, error: 'Only an owner can do this. Ask an owner if it needs changing.' });
    }

    if (route === '/me' && method === 'GET') return sendJson(res, 200, { ok: true, user, csrf: session.csrf, twoFactor: auth.twoFactorStatus(session) });

    if (route === '/logout' && method === 'POST') {
      await auth.logout(session);
      await audit.record('logout', actor);
      res.setHeader('Set-Cookie', auth.clearCookie());
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/dashboard' && method === 'GET') {
      const [status, activity] = await Promise.all([getStatus(), audit.recent(10)]);
      return sendJson(res, 200, { ok: true, status, inquiries: inquiries.recent(5), activity, problems: settings.problems() });
    }

    if (route === '/settings' && method === 'GET') {
      return sendJson(res, 200, { ok: true, settings: settings.describe(), problems: settings.problems() });
    }
    if (route === '/settings' && method === 'PUT') {
      const body = await readJsonBody(req, res);
      if (!body) return undefined;
      const result = await settings.update({ changes: body.changes || {}, reset: body.reset || [] }, user.username);
      if (result.errors) return sendJson(res, 400, { ok: false, error: result.errors.join(' ') });
      if (result.changed.length) await audit.record('settings-changed', { ...actor, details: { settings: result.changed } });
      return sendJson(res, 200, { ok: true, changed: result.changed, settings: settings.describe(), problems: settings.problems() });
    }

    if (route === '/test/email' && method === 'POST') {
      const result = await testEmail();
      await audit.record('test-email', { ...actor, details: { ok: result.ok } });
      return sendJson(res, 200, result);
    }
    if (route === '/test/instagram' && method === 'POST') {
      const result = await testInstagram();
      await audit.record('test-instagram', { ...actor, details: { ok: result.ok } });
      return sendJson(res, 200, result);
    }

    if (route === '/sessions' && method === 'GET') return sendJson(res, 200, { ok: true, sessions: auth.listSessions(session) });
    if (route === '/sessions/revoke-others' && method === 'POST') {
      const count = await auth.revokeOtherSessions(session);
      await audit.record('sessions-revoked', { ...actor, details: { count } });
      return sendJson(res, 200, { ok: true, signedOut: count });
    }

    if (route === '/password' && method === 'POST') {
      const body = await readJsonBody(req, res);
      if (!body) return undefined;
      const result = await auth.changePassword(session, body.currentPassword, body.newPassword);
      if (!result.ok) {
        await audit.record('password-change-failed', actor);
        return sendJson(res, result.status, { ok: false, error: result.error });
      }
      await audit.record('password-changed', { ...actor, details: { otherSessionsSignedOut: result.signedOut } });
      return sendJson(res, 200, { ok: true, signedOut: result.signedOut });
    }

    if (route.startsWith('/content')) return handleContent(req, res, route, method, actor, session);
    if (route === '/media' || route.startsWith('/media/')) return handleMedia(req, res, route, method, actor);
    if (route === '/inquiries' || route.startsWith('/inquiries/')) return handleInquiries(req, res, route, method, actor);
    if (route.startsWith('/account/two-factor')) return handleTwoFactor(req, res, route, method, actor, session);
    if (route === '/users' || route.startsWith('/users/')) return handleUsers(req, res, route, method, actor, session);
    if (route === '/backup' || route.startsWith('/backup/')) return handleBackup(req, res, route, method, actor, session);
    if (route === '/security' || route.startsWith('/security/')) return handleSecurity(req, res, route, method, actor);

    return notFound(res);
  }

  // ---------- Security: package vulnerability scan and fixes (owners only) ----------

  async function handleSecurity(req, res, route, method, actor) {
    const github = () => ({ configured: githubActions.configured(), repo: settings.get('githubRepo') || null });
    if (route === '/security' && method === 'GET') {
      return sendJson(res, 200, { ok: true, scan: vulnerabilities.state(), github: github() });
    }
    if (route === '/security/runs' && method === 'GET') {
      if (!githubActions.configured()) return sendJson(res, 200, { ok: true, runs: [], github: github() });
      try {
        return sendJson(res, 200, { ok: true, runs: await githubActions.recentRuns(), github: github() });
      } catch (err) {
        return sendJson(res, err.status || 502, { ok: false, error: err.message });
      }
    }
    if (method !== 'POST') return notFound(res);
    const body = await readJsonBody(req, res);
    if (!body) return undefined;

    if (route === '/security/scan') {
      // The owner sees the results on screen, so the daily email won't repeat them.
      const result = await vulnerabilities.scan({ markSeen: true });
      if (!result.skipped) await audit.record('security-scan', { ...actor, details: { ok: result.ok, found: result.findings.length } });
      return sendJson(res, 200, { ok: true, scan: vulnerabilities.state(), skipped: Boolean(result.skipped), github: github() });
    }
    if (route === '/security/fix') {
      // Only problems from the latest scan can be fixed, with the version the scan found.
      const finding = typeof body.id === 'string' && typeof body.package === 'string' ? vulnerabilities.finding(body.id, body.package) : null;
      if (!finding) return sendJson(res, 404, { ok: false, error: 'That problem is not in the latest scan. Scan again and retry.' });
      try {
        const links = await githubActions.requestFix({ package: finding.package, version: vulnerabilities.fixTarget(finding.package), advisory: finding.id });
        await audit.record('security-fix-requested', { ...actor, details: { package: finding.package, advisory: finding.id } });
        return sendJson(res, 200, { ok: true, ...links });
      } catch (err) {
        await audit.record('security-fix-failed', { ...actor, details: { package: finding.package, reason: String(err.message).slice(0, 120) } });
        return sendJson(res, err.status || 502, { ok: false, error: err.message });
      }
    }
    return notFound(res);
  }

  // ---------- Two-step sign-in for your own account ----------

  async function handleTwoFactor(req, res, route, method, actor, session) {
    if (route === '/account/two-factor' && method === 'GET') return sendJson(res, 200, { ok: true, ...auth.twoFactorStatus(session) });
    if (method !== 'POST') return notFound(res);
    const body = await readJsonBody(req, res);
    if (!body) return undefined;
    const fail = (result) => sendJson(res, result.status, { ok: false, error: result.error });

    if (route === '/account/two-factor/start') {
      const confirmed = await auth.confirmPassword(session, body.password, actor.ip);
      if (!confirmed.ok) return fail(confirmed);
      const result = await auth.startTwoFactor(session, { issuer: settings.get('siteName') });
      if (!result.ok) return fail(result);
      const svg = await QRCode.toString(result.uri, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      return sendJson(res, 200, {
        ok: true, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
        // Shown in groups of four for typing into the app by hand.
        secret: result.secret.match(/.{1,4}/g).join(' '),
      });
    }
    if (route === '/account/two-factor/confirm') {
      const result = await auth.confirmTwoFactor(session, body.code, actor.ip);
      if (!result.ok) return fail(result);
      await audit.record('two-factor-on', { ...actor, details: { otherSessionsSignedOut: result.signedOut } });
      return sendJson(res, 200, { ok: true, recoveryCodes: result.recoveryCodes, signedOut: result.signedOut });
    }
    if (route === '/account/two-factor/disable' || route === '/account/two-factor/recovery-codes') {
      const confirmed = await auth.confirmPassword(session, body.password, actor.ip);
      if (!confirmed.ok) return fail(confirmed);
      if (route.endsWith('/disable')) {
        const result = await auth.disableTwoFactor(session, body.code, actor.ip);
        if (!result.ok) return fail(result);
        await audit.record('two-factor-off', actor);
        return sendJson(res, 200, { ok: true });
      }
      const result = await auth.newRecoveryCodes(session, body.code, actor.ip);
      if (!result.ok) return fail(result);
      await audit.record('recovery-codes-renewed', actor);
      return sendJson(res, 200, { ok: true, recoveryCodes: result.recoveryCodes });
    }
    return notFound(res);
  }

  // ---------- Admin accounts (owners only) ----------

  async function handleUsers(req, res, route, method, actor, session) {
    const list = () => auth.listUsers().map((u) => ({ ...u, you: u.id === session.userId }));
    if (route === '/users' && method === 'GET') return sendJson(res, 200, { ok: true, users: list() });
    if (method !== 'POST' && method !== 'PUT') return notFound(res);
    const body = await readJsonBody(req, res);
    if (!body) return undefined;
    // Every change to admin accounts asks for the owner's own password again.
    const confirmed = await auth.confirmPassword(session, body.confirmPassword, actor.ip);
    if (!confirmed.ok) return sendJson(res, confirmed.status, { ok: false, error: confirmed.error });

    if (route === '/users' && method === 'POST') {
      try {
        const created = await auth.createUser(body.username, body.password, { role: body.role === 'editor' ? 'editor' : 'owner' });
        await audit.record('admin-added', { ...actor, details: { admin: created.username, role: created.role } });
        return sendJson(res, 200, { ok: true, users: list() });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    const match = USER_ROUTE.exec(route);
    if (!match) return notFound(res);
    const [, id, action] = match;
    const target = auth.listUsers().find((u) => u.id === id);
    if (!target) return sendJson(res, 404, { ok: false, error: 'That admin no longer exists. Reload the page.' });
    const self = id === session.userId;
    let result;
    if (!action && method === 'PUT') {
      result = await auth.setRole(id, body.role);
      if (result.ok) await audit.record('admin-role-changed', { ...actor, details: { admin: target.username, role: body.role } });
    } else if (action === 'password' && method === 'POST') {
      if (self) return sendJson(res, 400, { ok: false, error: 'Change your own password on the Account tab.' });
      result = await auth.setPasswordFor(id, body.password);
      if (result.ok) await audit.record('admin-password-set', { ...actor, details: { admin: target.username } });
    } else if (action === 'two-factor-off' && method === 'POST') {
      if (self) return sendJson(res, 400, { ok: false, error: 'Turn off your own two-step sign-in on the Account tab.' });
      result = await auth.disableTwoFactorFor(id);
      if (result.ok) await audit.record('admin-two-factor-off', { ...actor, details: { admin: target.username } });
    } else if (action === 'remove' && method === 'POST') {
      if (self) return sendJson(res, 400, { ok: false, error: 'You can\'t remove yourself. Ask another owner.' });
      result = await auth.removeUser(id);
      if (result.ok) await audit.record('admin-removed', { ...actor, details: { admin: target.username } });
    } else {
      return notFound(res);
    }
    if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
    return sendJson(res, 200, { ok: true, users: list(), signedOut: result.signedOut });
  }

  // ---------- Backups (owners only) ----------

  async function handleBackup(req, res, route, method, actor, session) {
    if (route === '/backup' && method === 'GET') {
      const backup = await backups.download(actor.user);
      await audit.record('backup-downloaded', actor);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="frosted-harmony-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      return res.end(JSON.stringify(backup));
    }
    if (route === '/backup/automatic' && method === 'GET') {
      return sendJson(res, 200, { ok: true, backups: await backups.listAutomatic() });
    }
    const automatic = AUTOMATIC_BACKUP.exec(route);
    if (automatic && method === 'GET') {
      const data = await backups.readAutomatic(automatic[1]);
      if (!data) return notFound(res);
      await audit.record('backup-downloaded', { ...actor, details: { automatic: automatic[1] } });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="frosted-harmony-${automatic[1]}"`,
      });
      return res.end(data);
    }
    if (route === '/backup/restore' && method === 'POST') {
      const body = await readJsonBody(req, res, RESTORE_BODY_LIMIT);
      if (!body) return undefined;
      const confirmed = await auth.confirmPassword(session, body.password, actor.ip);
      if (!confirmed.ok) return sendJson(res, confirmed.status, { ok: false, error: confirmed.error });
      const result = await backups.restore(body.backup, actor.user);
      if (!result.ok) {
        await audit.record('backup-restore-failed', { ...actor, details: { reason: result.error.slice(0, 120) } });
        return sendJson(res, result.status, { ok: false, error: result.error });
      }
      await audit.record('backup-restored', { ...actor, details: { from: result.summary.createdAt, automaticBackup: result.automatic } });
      return sendJson(res, 200, { ok: true, summary: result.summary, notes: result.notes, automatic: result.automatic });
    }
    return notFound(res);
  }

  async function handleInquiries(req, res, route, method, actor) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const filters = { view: params.get('view') || 'open', q: params.get('q') || '' };

    if (route === '/inquiries' && method === 'GET') {
      return sendJson(res, 200, { ok: true, ...inquiries.list({ ...filters, offset: params.get('offset'), limit: params.get('limit') }) });
    }
    if (route === '/inquiries/export.csv' && method === 'GET') {
      const csv = inquiries.csv(filters);
      await audit.record('inquiries-exported', { ...actor, details: { view: filters.view } });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="inquiries-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      return res.end(csv);
    }
    if (route === '/inquiries/delete-spam' && method === 'POST') {
      const removed = await inquiries.removeSpam();
      await audit.record('inquiries-spam-deleted', { ...actor, details: { count: removed } });
      return sendJson(res, 200, { ok: true, removed, counts: inquiries.counts() });
    }

    const match = INQUIRY_ID.exec(route);
    if (!match) return notFound(res);
    const [, id, resend] = match;
    if (!inquiries.get(id)) return sendJson(res, 404, { ok: false, error: 'That inquiry no longer exists. Reload the list.' });

    if (resend && method === 'POST') {
      const result = await resendInquiry(id);
      await audit.record('inquiry-resent', { ...actor, details: { inquiry: id, ok: result.ok } });
      if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error, inquiry: result.inquiry });
      return sendJson(res, 200, { ok: true, inquiry: result.inquiry, message: result.message, counts: inquiries.counts() });
    }
    if (resend) return notFound(res);

    if (method === 'PUT') {
      const body = await readJsonBody(req, res);
      if (!body) return undefined;
      const changes = {};
      for (const name of ['handled', 'spam']) {
        if (body[name] === undefined) continue;
        if (typeof body[name] !== 'boolean') return sendJson(res, 400, { ok: false, error: 'Invalid request.' });
        changes[name] = body[name];
      }
      if (!Object.keys(changes).length) return sendJson(res, 400, { ok: false, error: 'Nothing to change.' });
      const inquiry = await inquiries.update(id, changes, actor.user);
      if (!inquiry) return sendJson(res, 404, { ok: false, error: 'That inquiry no longer exists. Reload the list.' });
      const action = changes.spam === true ? 'inquiry-marked-spam' : changes.spam === false ? 'inquiry-not-spam'
        : changes.handled ? 'inquiry-handled' : 'inquiry-reopened';
      await audit.record(action, { ...actor, details: { inquiry: id } });
      return sendJson(res, 200, { ok: true, inquiry, counts: inquiries.counts() });
    }
    if (method === 'DELETE') {
      await inquiries.remove(id);
      await audit.record('inquiry-deleted', { ...actor, details: { inquiry: id } });
      return sendJson(res, 200, { ok: true, counts: inquiries.counts() });
    }
    return notFound(res);
  }

  const withUsage = (photo) => ({ ...photo, usedIn: content.usage(photo.id) });

  async function handleMedia(req, res, route, method, actor) {
    const photoError = (err) => {
      if (err && err.status) return sendJson(res, err.status, { ok: false, error: err.message });
      throw err;
    };

    if (route === '/media' && method === 'GET') {
      return sendJson(res, 200, { ok: true, photos: media.list().map(withUsage) });
    }

    if (route === '/media' && method === 'POST') {
      let buffer;
      try {
        buffer = await readBodyBuffer(req, PHOTO_BODY_LIMIT);
      } catch (err) {
        if (err.code === 'TOO_LARGE') return sendJson(res, 413, { ok: false, error: 'Photos can be at most 20 MB.' });
        throw err;
      }
      let alt = '';
      try {
        alt = decodeURIComponent(String(req.headers['x-photo-description'] || ''));
      } catch {
        alt = '';
      }
      try {
        const photo = await media.add(buffer, { alt, by: actor.user });
        await audit.record('photo-uploaded', { ...actor, details: { photo: photo.id } });
        return sendJson(res, 200, { ok: true, photo: withUsage(photo) });
      } catch (err) {
        return photoError(err);
      }
    }

    const match = /^\/media\/([A-Za-z0-9]{16})$/.exec(route);
    if (!match) return notFound(res);
    const id = match[1];

    if (method === 'PUT') {
      const body = await readJsonBody(req, res);
      if (!body) return undefined;
      try {
        // One step inside the content queue: nobody can publish this photo between the in-use check,
        // the update and refreshing the live page.
        const photo = await content.exclusive(async () => {
          const updated = await media.update(id, { alt: body.alt }, actor.user, { requireText: content.usage(id).length > 0 });
          // Descriptions are not page content, so the live page picks up the new text straight away.
          await content.regenerate();
          return updated;
        });
        await audit.record('photo-described', { ...actor, details: { photo: id } });
        return sendJson(res, 200, { ok: true, photo: withUsage(photo) });
      } catch (err) {
        return photoError(err);
      }
    }

    if (method === 'DELETE') {
      try {
        // Inside the content queue, so nobody can put the photo on the page while it is being deleted.
        await content.exclusive(() => media.remove(id, (photoId) => content.usage(photoId)));
        await audit.record('photo-deleted', { ...actor, details: { photo: id } });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return photoError(err);
      }
    }
    return notFound(res);
  }

  async function contentResponse(extra = {}) {
    return { ok: true, ...content.state(), history: await content.history(), design: DESIGN_OPTIONS, editor: EDITOR_OPTIONS, ...extra };
  }

  // ---------- Live preview of unsaved edits ----------

  function renderLivePreview(res, entry, rest) {
    const base = `/api/admin/content/live-preview/${entry.token}`;
    if (rest === 'theme.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(theme.themeCss(entry.content.theme) || '');
    }
    const page = entry.content.pages.find((p) => p.slug === (rest || ''));
    if (!page) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('That page is not part of this preview.');
    }
    const css = theme.themeCss(entry.content.theme);
    const html = renderPage(entry.content, {
      pageId: page.id, preview: true, photos: media.lookup(), markBlocks: true,
      assets: css ? { themeHref: `${base}/theme.css?v=${crypto.createHash('sha256').update(css).digest('hex').slice(0, 12)}` } : {},
      linkFor: (slug) => `${base}/${slug}`,
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    return res.end(html);
  }

  function storePreview(session, previewContent) {
    const now = Date.now();
    for (const [key, entry] of previews) if (entry.expires < now) previews.delete(key);
    if (previews.size >= PREVIEW_MAX && !previews.has(session.idHash)) previews.delete(previews.keys().next().value);
    const entry = { token: crypto.randomBytes(16).toString('base64url'), content: previewContent, expires: now + PREVIEW_MS };
    previews.set(session.idHash, entry);
    return entry;
  }

  async function handleContent(req, res, route, method, actor, session) {
    if (route === '/content' && method === 'GET') return sendJson(res, 200, await contentResponse());

    const live = LIVE_PREVIEW.exec(route);
    if (live && method === 'GET') {
      // Only the session that made a preview can see it.
      const entry = previews.get(session.idHash);
      if (!entry || entry.token !== live[1] || entry.expires < Date.now()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('This preview has expired. Make a change in the editor to refresh it.');
      }
      return renderLivePreview(res, entry, live[2]);
    }

    if (method !== 'POST' && method !== 'PUT') return notFound(res);
    const body = await readJsonBody(req, res, CONTENT_BODY_LIMIT);
    if (!body) return undefined;

    if (route === '/content/live-preview' && method === 'POST') {
      // Unsaved edits, shown as they would look. Problems are listed but don't stop the preview.
      const { content: previewContent, errors } = contentModel.normalizeContent(body.content, { photos: media.lookup(), missingPhotos: 'drop' });
      const entry = storePreview(session, previewContent);
      return sendJson(res, 200, { ok: true, base: `/api/admin/content/live-preview/${entry.token}`, errors });
    }

    if (route === '/content' && method === 'PUT') {
      const result = await content.saveDraft(body.content, body.revision, actor.user);
      if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
      await audit.record('content-draft-saved', actor);
      return sendJson(res, 200, await contentResponse());
    }
    if (route === '/content/publish' && method === 'POST') {
      const result = await content.publish(actor.user, body.revision);
      if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
      await audit.record('content-published', actor);
      return sendJson(res, 200, await contentResponse());
    }
    if (route === '/content/discard' && method === 'POST') {
      await content.discard(actor.user);
      await audit.record('content-draft-discarded', actor);
      return sendJson(res, 200, await contentResponse());
    }
    if (route === '/content/restore' && method === 'POST') {
      const result = await content.restore(body.id, { publish: body.publish === true, revision: body.revision }, actor.user);
      if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
      await audit.record(body.publish === true ? 'content-restored-and-published' : 'content-restored-to-draft', { ...actor, details: { version: String(body.id) } });
      return sendJson(res, 200, await contentResponse());
    }
    return notFound(res);
  }

  return { handle };
}

module.exports = { createAdminRoutes, ADMIN_BODY_LIMIT };
