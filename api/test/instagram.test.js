'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInstagramClient, tokenKind, GRAPH_VERSION } = require('../lib/instagram');

// A fake Graph API: answers by URL path and records every call.
function fakeGraph(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const key = `${u.host}${u.pathname}`;
    const answer = routes[key];
    if (!answer) return { ok: false, status: 404, json: async () => ({ error: { message: `no route ${key}`, code: 100 } }) };
    const [status, body] = typeof answer === 'function' ? answer(u) : answer;
    return { ok: status < 400, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

const POSTS = [{ id: '1', media_type: 'IMAGE', media_url: 'https://cdn.example/1.jpg', permalink: 'https://instagram.com/p/1' }];

test('tokens are recognised by their prefix', () => {
  assert.equal(tokenKind('IGAAbc123'), 'instagram');
  assert.equal(tokenKind('EAAGm0PX4ZCpsBA'), 'business');
  assert.equal(tokenKind('something-old'), 'instagram');
});

test('Instagram login tokens use graph.instagram.com and can be renewed', async () => {
  const graph = fakeGraph({
    'graph.instagram.com/me': [200, { user_id: '178', username: 'frostedharmony' }],
    'graph.instagram.com/me/media': [200, { data: POSTS }],
    'graph.instagram.com/refresh_access_token': (u) => [200, { access_token: `${u.searchParams.get('access_token')}-new`, expires_in: 5184000 }],
  });
  const ig = createInstagramClient({ fetchImpl: graph.fetchImpl });
  assert.deepEqual(await ig.account('IGAAtoken'), { kind: 'instagram', id: '178', username: 'frostedharmony' });
  assert.deepEqual(await ig.media('IGAAtoken', { limit: 12 }), POSTS);
  assert.equal(graph.calls[1].searchParams.get('limit'), '12');
  assert.deepEqual(await ig.refresh('IGAAtoken'), { token: 'IGAAtoken-new', expiresIn: 5184000 });
});

test('business tokens find the Instagram account through the linked Facebook Page, once', async () => {
  const graph = fakeGraph({
    [`graph.facebook.com/${GRAPH_VERSION}/me/accounts`]: [200, { data: [
      { name: 'Unrelated page' },
      { name: 'Frosted Harmony', instagram_business_account: { id: '17841400000000001', username: 'frostedharmony' } },
    ] }],
    [`graph.facebook.com/${GRAPH_VERSION}/17841400000000001/media`]: [200, { data: POSTS }],
  });
  const ig = createInstagramClient({ fetchImpl: graph.fetchImpl });
  assert.deepEqual(await ig.account('EAAbusiness'), { kind: 'business', id: '17841400000000001', username: 'frostedharmony' });
  assert.deepEqual(await ig.media('EAAbusiness', { limit: 6 }), POSTS);
  assert.deepEqual(await ig.media('EAAbusiness', { limit: 6 }), POSTS);
  assert.equal(graph.calls.filter((u) => u.pathname.endsWith('/me/accounts')).length, 1, 'the lookup is remembered');
  assert.equal(await ig.refresh('EAAbusiness'), null, 'business tokens are not renewed with the Instagram endpoint');
  assert.ok(graph.calls.every((u) => u.host === 'graph.facebook.com'));
});

test('a business token with an account ID set skips the Page lookup', async () => {
  const graph = fakeGraph({
    [`graph.facebook.com/${GRAPH_VERSION}/42424242`]: [200, { id: '42424242', username: 'frostedharmony' }],
    [`graph.facebook.com/${GRAPH_VERSION}/42424242/media`]: [200, { data: POSTS }],
  });
  const ig = createInstagramClient({ fetchImpl: graph.fetchImpl });
  assert.equal((await ig.media('EAAbusiness', { limit: 3, accountId: '42424242' })).length, 1);
  assert.ok(!graph.calls.some((u) => u.pathname.endsWith('/me/accounts')));
});

test('problems are explained in plain words', async () => {
  const graph = fakeGraph({
    'graph.instagram.com/me/media': [400, { error: { message: 'Error validating access token: Session has expired', code: 190 } }],
    [`graph.facebook.com/${GRAPH_VERSION}/me/accounts`]: [200, { data: [{ name: 'Page without Instagram' }] }],
  });
  const ig = createInstagramClient({ fetchImpl: graph.fetchImpl });
  await assert.rejects(ig.media('IGAAold', { limit: 1 }), /expired or was revoked\. Create a new token/);
  await assert.rejects(ig.account('EAAnopage'), /cannot see a Facebook Page with an Instagram account/);
  const offline = createInstagramClient({ fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  await assert.rejects(offline.account('IGAAx'), /Could not reach Instagram: getaddrinfo ENOTFOUND/);
});

test('changing the account ID uses the new account even with the same token', async () => {
  const graph = fakeGraph({
    [`graph.facebook.com/${GRAPH_VERSION}/me/accounts`]: [200, { data: [{ instagram_business_account: { id: '111111', username: 'old_account' } }] }],
    [`graph.facebook.com/${GRAPH_VERSION}/222222`]: [200, { id: '222222', username: 'new_account' }],
  });
  const ig = createInstagramClient({ fetchImpl: graph.fetchImpl });
  assert.equal((await ig.account('EAAsame')).username, 'old_account');
  // Even without forget() (e.g. a refresh that was already running refilled the cache), the ID wins.
  assert.equal((await ig.account('EAAsame', '222222')).username, 'new_account');
  assert.equal((await ig.account('EAAsame')).username, 'old_account');
});