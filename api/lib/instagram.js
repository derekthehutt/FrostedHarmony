'use strict';

// Talks to Instagram. Two kinds of access token work:
//   - Instagram Login tokens (start with "IG"): made in the Meta app's "API setup with Instagram
//     login". They expire after 60 days, so they are refreshed automatically.
//   - Business tokens (start with "EAA"): system-user or Page tokens from a Meta business portfolio
//     ("API setup with Facebook login" / unified login). These go through graph.facebook.com and
//     the Facebook Page linked to the Instagram account. System-user tokens can be set to never expire.

const GRAPH_VERSION = 'v27.0';
const MEDIA_FIELDS = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
const TIMEOUT_MS = 20_000;

const tokenKind = (token) => (/^EAA/.test(String(token || '')) ? 'business' : 'instagram');

class InstagramError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Meta's messages are written for developers; the common ones get plain explanations.
function explain(body, status) {
  const err = (body && body.error) || {};
  const code = err.code;
  let message = err.message || `HTTP ${status}`;
  if (code === 190) message = `The access token has expired or was revoked. Create a new token and paste it in Settings. (${message})`;
  else if (code === 10 || code === 200 || (code >= 200 && code < 300)) message = `The token is missing a permission. (${message})`;
  else if (code === 4 || code === 17 || code === 32 || code === 613) message = `Instagram is limiting requests right now; the site will try again later. (${message})`;
  return new InstagramError(message, { status, code });
}

function createInstagramClient({ fetchImpl = (...args) => fetch(...args) } = {}) {
  // Business tokens: the Instagram account found for the token (and the account ID setting), so the
  // lookup isn't repeated hourly.
  let found = { key: null, id: null, username: null };

  async function get(base, pathname, params) {
    const url = new URL(`${base}${pathname}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new InstagramError(`Could not reach Instagram: ${err.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw explain(body, res.status);
    return body;
  }

  const igGet = (pathname, params) => get('https://graph.instagram.com', pathname, params);
  const fbGet = (pathname, params) => get(`https://graph.facebook.com/${GRAPH_VERSION}`, pathname, params);

  // Business tokens reach Instagram through a Facebook Page. Returns { id, username }.
  async function businessAccount(token, accountId) {
    const key = `${token}\n${accountId || ''}`;
    if (found.key === key && found.id) return { id: found.id, username: found.username };
    if (accountId) {
      const body = await fbGet(`/${accountId}`, { fields: 'id,username', access_token: token });
      found = { key, id: String(body.id), username: body.username || null };
      return { id: found.id, username: found.username };
    }
    const pages = await fbGet('/me/accounts', { fields: 'name,instagram_business_account{id,username}', limit: '100', access_token: token });
    const page = (pages.data || []).find((p) => p.instagram_business_account && p.instagram_business_account.id);
    if (!page) {
      throw new InstagramError('This token cannot see a Facebook Page with an Instagram account linked to it. In Meta Business settings, give the system user access to the Page (and its Instagram account), or enter the Instagram account ID in Settings.');
    }
    found = { key, id: String(page.instagram_business_account.id), username: page.instagram_business_account.username || null };
    return { id: found.id, username: found.username };
  }

  // { kind, username, id }
  async function account(token, accountId) {
    if (tokenKind(token) === 'business') return { kind: 'business', ...(await businessAccount(token, accountId)) };
    const body = await igGet('/me', { fields: 'user_id,username', access_token: token });
    return { kind: 'instagram', id: body.user_id ? String(body.user_id) : null, username: body.username || null };
  }

  async function media(token, { limit, accountId }) {
    if (tokenKind(token) === 'business') {
      const { id } = await businessAccount(token, accountId);
      return (await fbGet(`/${id}/media`, { fields: MEDIA_FIELDS, limit: String(limit), access_token: token })).data || [];
    }
    return (await igGet('/me/media', { fields: MEDIA_FIELDS, limit: String(limit), access_token: token })).data || [];
  }

  // Instagram Login tokens only. Returns { token, expiresIn } or null when this kind can't be refreshed.
  async function refresh(token) {
    if (tokenKind(token) === 'business') return null;
    const body = await igGet('/refresh_access_token', { grant_type: 'ig_refresh_token', access_token: token });
    if (!body.access_token) throw new InstagramError('Instagram did not return a new token.');
    return { token: body.access_token, expiresIn: body.expires_in || null };
  }

  function forget() {
    found = { key: null, id: null, username: null };
  }

  return { account, media, refresh, forget };
}

module.exports = { createInstagramClient, tokenKind, InstagramError, GRAPH_VERSION };
