'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInquiryStore } = require('../lib/inquiries');

const DAY = 24 * 60 * 60 * 1000;

function setup(lines = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-inquiries-'));
  const file = path.join(dir, 'inquiries.jsonl');
  if (lines.length) fs.writeFileSync(file, `${lines.join('\n')}\n`);
  let clock = Date.parse('2026-11-01T12:00:00Z');
  const store = createInquiryStore({ file, now: () => clock });
  return { file, store, tick: (ms) => { clock += ms; } };
}

const sample = (name, extra = {}) => ({ name, email: `${name.toLowerCase()}@example.com`, phone: '', inquiryType: 'pricing', eventDate: '', quantity: '', message: `Hello from ${name}, I need cupcakes.`, ...extra });

test('inquiries saved before the inbox existed get ids that stay the same', async () => {
  const old = [
    JSON.stringify({ receivedAt: '2026-10-01T10:00:00.000Z', ...sample('Ann') }),
    JSON.stringify({ receivedAt: '2026-10-20T10:00:00.000Z', spam: true, ...sample('Bot') }),
    'not json at all',
  ];
  const { file, store } = setup(old);
  await store.load();
  const first = store.list({ view: 'all' }).items.map((q) => q.id);
  assert.equal(first.length, 2, 'the unreadable line is not shown');
  const again = createInquiryStore({ file });
  await again.load();
  assert.deepEqual(again.list({ view: 'all' }).items.map((q) => q.id), first);
  assert.ok(fs.readFileSync(file, 'utf8').includes('not json at all'), 'unreadable lines are kept, not lost');
  assert.match(fs.readFileSync(file, 'utf8'), /"id":"[0-9a-f]{16}"/);
});

test('views, counts, search and newest-first order', async () => {
  const { store, tick } = setup();
  await store.load();
  const ann = await store.add(sample('Ann'), { delivery: 'sent' });
  tick(1000);
  const bea = await store.add(sample('Bea', { message: 'Wedding for 200 guests, lemon flavor please' }));
  tick(1000);
  await store.add(sample('Spammer'), { spam: true, delivery: 'skipped' });
  await store.update(ann.id, { handled: true }, 'derek');

  assert.deepEqual(store.counts(), { open: 1, handled: 1, spam: 1, all: 3 });
  assert.deepEqual(store.list({ view: 'open' }).items.map((q) => q.name), ['Bea']);
  assert.deepEqual(store.list({ view: 'all' }).items.map((q) => q.name), ['Spammer', 'Bea', 'Ann']);
  const handled = store.list({ view: 'handled' }).items[0];
  assert.equal(handled.handledBy, 'derek');
  assert.equal(handled.delivery.status, 'sent');
  assert.deepEqual(store.list({ view: 'all', q: 'LEMON' }).items.map((q) => q.id), [bea.id]);
  assert.equal(store.list({ view: 'all', limit: 2 }).items.length, 2);
  assert.equal(store.list({ view: 'all', offset: 2, limit: 2 }).items[0].name, 'Ann');
  assert.deepEqual(store.recent(5).map((q) => q.name), ['Bea', 'Ann'], 'the dashboard leaves out spam');

  await store.update(ann.id, { handled: false });
  assert.equal(store.get(ann.id).handled, false);
  assert.equal(store.get(ann.id).handledBy, null);
});

test('spam can be rescued, deleted one by one or all at once', async () => {
  const { file, store } = setup();
  await store.load();
  const real = await store.add(sample('Real'), { spam: true });
  await store.add(sample('Bot1'), { spam: true });
  await store.add(sample('Bot2'), { spam: true });
  await store.update(real.id, { spam: false });
  assert.equal(store.get(real.id).spam, false);
  assert.equal(await store.removeSpam(), 2);
  assert.equal(store.counts().all, 1);
  assert.equal(await store.remove(real.id), true);
  assert.equal(await store.remove(real.id), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('spam older than 30 days is removed; real inquiries are never removed automatically', async () => {
  const { store, tick } = setup();
  await store.load();
  await store.add(sample('Old bot'), { spam: true });
  await store.add(sample('Old customer'));
  tick(31 * DAY);
  await store.add(sample('New bot'), { spam: true });
  await store.prune();
  assert.deepEqual(store.list({ view: 'all' }).items.map((q) => q.name), ['New bot', 'Old customer']);
});

test('an inquiry arriving while another is being changed is never lost', async () => {
  const { file, store } = setup();
  await store.load();
  const first = await store.add(sample('First'));
  const results = await Promise.all([
    store.update(first.id, { handled: true }, 'derek'),
    store.add(sample('During')),
    store.remove(first.id),
    store.add(sample('After')),
  ]);
  assert.equal(results[2], true);
  const reloaded = createInquiryStore({ file });
  await reloaded.load();
  assert.deepEqual(reloaded.list({ view: 'all' }).items.map((q) => q.name), ['After', 'During']);
});

test('the spreadsheet export cannot run formulas and keeps accents readable in Excel', async () => {
  const { store } = setup();
  await store.load();
  await store.add(sample('=HYPERLINK("http://evil")', { message: '+1 dozen "vanilla", crème brûlée' }));
  const csv = store.csv({ view: 'all' });
  assert.ok(csv.startsWith('\ufeff"Received","Status"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil"")"'));
  assert.ok(csv.includes('"\'+1 dozen ""vanilla"", crème brûlée"'));
  assert.ok(csv.includes('"Needs reply"'));
});

test('the inquiry file is not readable by other users (Linux/macOS only)', { skip: process.platform === 'win32' }, async () => {
  const { file, store } = setup();
  await store.load();
  const q = await store.add(sample('Ann'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  await store.update(q.id, { handled: true });
  assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'rewrites keep the same permissions');
});
