'use strict';

// /api/admin/* routes. Everything except /status and /login requires a signed-in session;
// every change also requires the session's CSRF token and a same-site Origin header.

const ADMIN_BODY_LIMIT = 64 * 1024;
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
  const { auth, settings, audit, readBody, sendJson, clientIp, keyConfigured, getStatus, testEmail, testInstagram, recentInquiries, content, renderPage } = deps;

  async function readJsonBody(req, res) {
    if (!/application\/json/i.test(req.headers['content-type'] || '')) {
      sendJson(res, 415, { ok: false, error: 'Expected JSON.' });
      return null;
    }
    try {
      const body = JSON.parse(await readBody(req, ADMIN_BODY_LIMIT));
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

  async function handle(req, res, pathname) {
    const route = pathname.slice('/api/admin'.length) || '/';
    const ip = clientIp(req);
    const method = req.method;

    if (route === '/status' && method === 'GET') {
      await auth.sync();
      return sendJson(res, 200, { ok: true, ready: keyConfigured && auth.hasUsers(), keyConfigured, hasUsers: auth.hasUsers() });
    }
    if (!keyConfigured) {
      return sendJson(res, 503, { ok: false, error: 'The admin portal is not set up yet: add ADMIN_ENCRYPTION_KEY to .env on the server.' });
    }
    if (route === '/login') return method === 'POST' ? handleLogin(req, res, ip) : notFound(res);

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

    if (route === '/me' && method === 'GET') return sendJson(res, 200, { ok: true, user, csrf: session.csrf });

    if (route === '/logout' && method === 'POST') {
      await auth.logout(session);
      await audit.record('logout', actor);
      res.setHeader('Set-Cookie', auth.clearCookie());
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/dashboard' && method === 'GET') {
      const [inquiries, activity] = await Promise.all([recentInquiries(5), audit.recent(10)]);
      return sendJson(res, 200, { ok: true, status: getStatus(), inquiries, activity, problems: settings.problems() });
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

    if (route.startsWith('/content')) return handleContent(req, res, route, method, actor);

    return notFound(res);
  }

  async function contentResponse(extra = {}) {
    return { ok: true, ...content.state(), history: await content.history(), ...extra };
  }

  async function handleContent(req, res, route, method, actor) {
    if (route === '/content' && method === 'GET') return sendJson(res, 200, await contentResponse());

    if (route === '/content/preview' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
      return res.end(renderPage(content.preview(), { preview: true }));
    }

    if (method !== 'POST' && method !== 'PUT') return notFound(res);
    const body = await readJsonBody(req, res);
    if (!body) return undefined;

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
