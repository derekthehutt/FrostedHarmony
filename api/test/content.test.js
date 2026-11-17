'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONTENT, normalizeContent, createContentStore } = require('../lib/content');
const { renderPage } = require('../lib/render');

const clone = (v) => JSON.parse(JSON.stringify(v));
// Ignore formatting-only differences: comments, whitespace and the escaped apostrophe.
const normalizeHtml = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').replace(/>\s+/g, '>').replace(/\s+</g, '<').trim();

function storeIn(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-content-'));
  let clock = 1_800_000_000_000;
  const store = createContentStore({ dir: path.join(root, 'admin', 'content'), siteDir: path.join(root, 'site'), render: renderPage, now: () => { clock += 1000; return clock; }, ...options });
  return { root, store };
}

test('the default content renders exactly the original hand-written page', () => {
  const original = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'index.html'), 'utf8');
  assert.equal(normalizeHtml(renderPage(normalizeContent(DEFAULT_CONTENT).content)), normalizeHtml(original));
});

test('anything typed in is escaped, so it cannot add HTML or scripts', () => {
  const content = clone(DEFAULT_CONTENT);
  content.hero.heading = '<script>alert(1)</script>';
  content.flavors.items[0].name = '"><img src=x onerror=alert(1)>';
  content.brand.name = 'Tom & Jerry\'s "Bakery"';
  content.hero.lead = 'Line one\nLine <b>two</b>';
  const html = renderPage(normalizeContent(content).content);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('aria-label="Tom &amp; Jerry&#39;s &quot;Bakery&quot; home"'));
  assert.ok(html.includes('Line one<br>\nLine &lt;b&gt;two&lt;/b&gt;'));
});

test('links must be a real Instagram https URL and a valid email', () => {
  const bad = clone(DEFAULT_CONTENT);
  bad.links.instagramUrl = 'javascript:alert(1)';
  bad.links.email = 'x" onclick="alert(1)';
  const { errors } = normalizeContent(bad);
  assert.equal(errors.length, 2);
  const lookalike = clone(DEFAULT_CONTENT);
  lookalike.links.instagramUrl = 'https://instagram.com.evil.example/x';
  assert.equal(normalizeContent(lookalike).errors.length, 1);
  const empty = clone(DEFAULT_CONTENT);
  empty.links.instagramUrl = '';
  const html = renderPage(normalizeContent(empty).content);
  assert.ok(!html.includes('data-instagram-link'));
});

test('validation reports empty required fields, long text and too many items', () => {
  const content = clone(DEFAULT_CONTENT);
  content.hero.heading = '   ';
  content.seo.title = 'x'.repeat(71);
  content.flavors.items = Array.from({ length: 41 }, (_, i) => ({ name: `Flavor ${i}` }));
  content.ordering.steps = [{ title: '', text: 'no title' }];
  const { errors } = normalizeContent(content);
  assert.equal(errors.length, 4);
  assert.match(errors.join(' '), /Main heading can't be empty|Top banner: main heading can't be empty/);
});

test('missing fields fall back to defaults; unknown fields are dropped; text is tidied', () => {
  const invisible = normalizeContent({ hero: { heading: ' \u0001\u0002 ' } });
  assert.match(invisible.errors.join(' '), /main heading can't be empty/i, 'invisible characters do not count as text');
  const { content, errors } = normalizeContent({ hero: { heading: '  New   heading  ' }, extra: 'nope', order: ['ordering', 'bogus', 'ordering'] });
  assert.deepEqual(errors, []);
  assert.equal(content.hero.heading, 'New heading');
  assert.equal(content.seo.title, DEFAULT_CONTENT.seo.title);
  assert.equal(content.flavors.items.length, 6);
  assert.equal(content.extra, undefined);
  assert.deepEqual(content.order, ['ordering', 'gallery', 'flavors']);
});

test('section order and visibility change the page and the menu', () => {
  const content = clone(DEFAULT_CONTENT);
  content.order = ['ordering', 'flavors', 'gallery'];
  content.gallery.visible = false;
  content.flavors.items[0].price = '$36 / dozen';
  const html = renderPage(normalizeContent(content).content);
  assert.ok(!html.includes('id="gallery"'));
  assert.ok(!html.includes('href="#gallery"'));
  assert.ok(html.indexOf('id="ordering"') < html.indexOf('id="flavors"'));
  assert.ok(html.indexOf('href="#ordering"') < html.indexOf('href="#flavors"'));
  assert.ok(html.includes('<p class="card-price">$36 / dozen</p>'));
  // With the gallery hidden, the second hero button points at the first visible section.
  assert.ok(html.includes('class="button button-outline" href="#ordering"'));
});

test('preview pages are marked, not indexed, and disable the form', () => {
  const html = renderPage(normalizeContent(DEFAULT_CONTENT).content, { preview: true });
  assert.ok(html.includes('data-preview="1"'));
  assert.ok(html.includes('noindex'));
  assert.ok(html.includes('preview-banner'));
});

test('draft, publish, history, restore and discard', async () => {
  const { root, store } = storeIn();
  await store.load();
  assert.equal(store.state().published, null);
  assert.equal(store.state().hasUnpublishedChanges, false);
  assert.equal(fs.existsSync(path.join(root, 'site', 'index.html')), false);

  const edited = clone(store.state().draft);
  edited.hero.heading = 'Version one';
  assert.equal((await store.saveDraft(edited, 0, 'derek')).ok, true);
  assert.equal(store.state().hasUnpublishedChanges, true);
  assert.equal(fs.existsSync(path.join(root, 'site', 'index.html')), false, 'saving a draft must not change the live page');

  assert.equal((await store.publish('derek', store.state().revision)).ok, true);
  const page = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
  assert.ok(page.includes('Version one'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'site', 'index.html')).mode & 0o777, 0o644);
  let history = await store.history();
  assert.deepEqual(history.map((h) => h.label), ['published', 'original']);
  assert.equal(history[0].live, true);

  const second = clone(store.state().draft);
  second.hero.heading = 'Version two';
  await store.saveDraft(second, store.state().revision, 'wife');
  await store.publish('wife', store.state().revision);
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes('Version two'));

  history = await store.history();
  const original = history.find((h) => h.label === 'original');
  assert.equal((await store.restore(original.id, { revision: store.state().revision }, 'derek')).ok, true);
  assert.equal(store.state().draft.hero.heading, DEFAULT_CONTENT.hero.heading);
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes('Version two'), 'restore to draft must not publish');

  await store.discard('derek');
  assert.equal(store.state().draft.hero.heading, 'Version two');

  const firstVersion = (await store.history()).find((h) => h.label === 'published' && !h.live);
  assert.equal((await store.restore(firstVersion.id, { publish: true }, 'derek')).ok, true);
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes('Version one'));

  assert.equal((await store.restore('../../etc/passwd', {}, 'x')).status, 400);
  assert.equal((await store.restore('123-nothere', {}, 'x')).status, 404);
});

test('a save based on an old revision is refused, even when two arrive at once', async () => {
  const { store } = storeIn();
  await store.load();
  const a = clone(store.state().draft);
  a.hero.heading = 'From Derek';
  const b = clone(store.state().draft);
  b.hero.heading = 'From his wife';
  const results = await Promise.all([store.saveDraft(a, 0, 'derek'), store.saveDraft(b, 0, 'wife')]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.equal(results.find((r) => !r.ok).status, 409);
});

test('a publish based on an old revision is refused, even when a save is still being written', async () => {
  const { store } = storeIn();
  await store.load();
  const seen = store.state().revision;
  const edited = clone(store.state().draft);
  edited.hero.heading = 'Saved by the other admin, never previewed';
  // The save is queued first; the publish was clicked while the page still showed the old revision.
  const [saved, published] = await Promise.all([store.saveDraft(edited, seen, 'wife'), store.publish('derek', seen)]);
  assert.equal(saved.ok, true);
  assert.equal(published.status, 409);
  assert.equal(store.state().published, null);
});

test('"put back live" publishes an old version without touching the shared draft', async () => {
  const { root, store } = storeIn();
  await store.load();
  const first = clone(store.state().draft);
  first.hero.heading = 'Live version';
  await store.saveDraft(first, store.state().revision, 'derek');
  await store.publish('derek', store.state().revision);

  const work = clone(store.state().draft);
  work.hero.heading = 'Unfinished work by the other admin';
  await store.saveDraft(work, store.state().revision, 'wife');
  const revisionBefore = store.state().revision;

  const original = (await store.history()).find((h) => h.label === 'original');
  assert.equal((await store.restore(original.id, { publish: true }, 'derek')).ok, true);
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes(DEFAULT_CONTENT.hero.heading));
  assert.equal(store.state().draft.hero.heading, 'Unfinished work by the other admin');
  assert.equal(store.state().revision, revisionBefore);

  // Copying into the draft still requires the current revision.
  assert.equal((await store.restore(original.id, { revision: revisionBefore - 1 }, 'derek')).status, 409);
});

test('invalid drafts are not saved', async () => {
  const { store } = storeIn();
  await store.load();
  const bad = clone(store.state().draft);
  bad.brand.name = '';
  const result = await store.saveDraft(bad, 0, 'derek');
  assert.equal(result.status, 400);
  assert.equal(store.state().revision, 0);
});

test('history keeps the newest 30 versions plus the original', async () => {
  const { store } = storeIn();
  await store.load();
  for (let i = 0; i < 33; i += 1) {
    const next = clone(store.state().draft);
    next.hero.heading = `Version ${i}`;
    await store.saveDraft(next, store.state().revision, 'derek');
    await store.publish('derek', store.state().revision);
  }
  const history = await store.history();
  assert.equal(history.length, 31);
  assert.equal(history.filter((h) => h.label === 'original').length, 1);
});

test('state survives a restart and the live page is regenerated', async () => {
  const { root, store } = storeIn();
  await store.load();
  const next = clone(store.state().draft);
  next.hero.heading = 'Persisted heading';
  await store.saveDraft(next, 0, 'derek');
  await store.publish('derek', store.state().revision);
  fs.rmSync(path.join(root, 'site', 'index.html'));

  const again = createContentStore({ dir: path.join(root, 'admin', 'content'), siteDir: path.join(root, 'site'), render: renderPage });
  await again.load();
  await again.regenerate();
  assert.equal(again.state().draft.hero.heading, 'Persisted heading');
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes('Persisted heading'));
});

// ---------- Photos ----------

const { photoUsage } = require('../lib/content');

const PHOTO_A = 'AAAAAAAAAAAAAAAA';
const PHOTO_B = 'BBBBBBBBBBBBBBBB';
const library = (alts = {}) => new Map([
  [PHOTO_A, { id: PHOTO_A, alt: alts.a === undefined ? 'Red velvet "cupcakes" <3' : alts.a, width: 3000, height: 2000, widths: [400, 800, 1600] }],
  [PHOTO_B, { id: PHOTO_B, alt: alts.b === undefined ? 'Lemon cupcakes' : alts.b, width: 600, height: 900, widths: [400, 600] }],
]);

test('photo references must exist; old versions quietly drop deleted photos', () => {
  const content = clone(DEFAULT_CONTENT);
  content.hero.image = PHOTO_A;
  content.gallery.photos = [PHOTO_A, 'CCCCCCCCCCCCCCCC', PHOTO_A, '../../etc/passwd'];
  content.flavors.items[0].image = 'CCCCCCCCCCCCCCCC';
  const strict = normalizeContent(content, { photos: library() });
  assert.equal(strict.errors.length, 3);
  const lenient = normalizeContent(content, { photos: library(), missingPhotos: 'drop' });
  assert.equal(lenient.errors.length, 1, 'a malformed id is always an error');
  assert.deepEqual(lenient.content.gallery.photos, [PHOTO_A], 'missing photos dropped, duplicates removed');
  assert.equal(lenient.content.flavors.items[0].image, '');
  assert.equal(lenient.content.hero.image, PHOTO_A);
});

test('the website address must be a plain https address', () => {
  for (const bad of ['http://frostedharmony.com', 'https://frostedharmony.com/path', 'javascript:alert(1)', 'https://user@frostedharmony.com']) {
    const content = clone(DEFAULT_CONTENT);
    content.seo.siteUrl = bad;
    assert.equal(normalizeContent(content).errors.length, 1, bad);
  }
  const ok = clone(DEFAULT_CONTENT);
  ok.seo.siteUrl = 'https://FrostedHarmony.com/';
  assert.equal(normalizeContent(ok).content.seo.siteUrl, 'https://frostedharmony.com');
});

test('photos render as responsive, escaped images; link previews use absolute URLs', () => {
  const content = clone(DEFAULT_CONTENT);
  content.hero.image = PHOTO_A;
  content.gallery.photos = [PHOTO_B, PHOTO_A];
  content.flavors.items[0].image = PHOTO_B;
  content.seo.shareImage = PHOTO_A;
  const html = renderPage(normalizeContent(content, { photos: library() }).content, { photos: library() });
  assert.ok(html.includes(`srcset="/uploads/${PHOTO_A}-400.webp 400w, /uploads/${PHOTO_A}-800.webp 800w, /uploads/${PHOTO_A}-1600.webp 1600w"`));
  assert.ok(html.includes('width="1600" height="1067"'), 'reserves space using the aspect ratio');
  assert.ok(html.includes('alt="Red velvet &quot;cupcakes&quot; &lt;3"'));
  assert.ok(html.includes('class="hero-photo"') && html.includes('fetchpriority="high"'));
  assert.ok(!html.includes('cupcake-illustration'), 'the drawing is replaced by the photo');
  assert.ok(html.indexOf(`/uploads/${PHOTO_B}-600.webp`) < html.indexOf(`/uploads/${PHOTO_A}-800.webp" srcset`, html.indexOf('gallery-grid')), 'gallery keeps the chosen order');
  assert.ok(html.includes('class="card card-with-photo"'));
  assert.ok(html.includes(`<meta property="og:image" content="https://frostedharmony.com/uploads/${PHOTO_A}-share.jpg">`));
  assert.ok(!html.includes('Loading photos...'), 'own photos replace the loading message');
  assert.ok(!html.includes('data-gallery-source'), 'the default "mixed" mode needs no attribute');

  content.gallery.source = 'instagram';
  const igOnly = renderPage(normalizeContent(content, { photos: library() }).content, { photos: library() });
  assert.ok(igOnly.includes('data-gallery-source="instagram"'));
  assert.ok(!igOnly.includes('class="gallery-photo"'), 'own gallery photos are not shown in Instagram-only mode');
  assert.ok(igOnly.includes('Loading photos...'));
});

test('photoUsage lists every place a photo appears', () => {
  const content = clone(DEFAULT_CONTENT);
  content.hero.image = PHOTO_A;
  content.gallery.photos = [PHOTO_A];
  content.flavors.items[5].image = PHOTO_A;
  content.seo.shareImage = PHOTO_B;
  const usage = photoUsage(content);
  assert.deepEqual(usage.get(PHOTO_A), ['Top banner', 'Gallery', 'Flavor: Red Velvet']);
  assert.deepEqual(usage.get(PHOTO_B), ['Link preview']);
});

test('publishing requires a description on every photo used', async () => {
  let photos = library({ a: '' });
  const { root, store } = storeIn({ photos: () => photos });
  await store.load();
  const next = clone(store.state().draft);
  next.gallery.photos = [PHOTO_A];
  assert.equal((await store.saveDraft(next, 0, 'derek')).ok, true, 'drafts may use undescribed photos');
  const blocked = await store.publish('derek', store.state().revision);
  assert.equal(blocked.status, 400);
  assert.match(blocked.error, /Gallery needs a description/);
  photos = library();
  assert.equal((await store.publish('derek', store.state().revision)).ok, true);
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes(`/uploads/${PHOTO_A}-400.webp`));
  assert.deepEqual(store.usage(PHOTO_A), ['Gallery']);
  assert.deepEqual(store.usage(PHOTO_B), []);
});

test('upgrading from a version without photo fields does not look like unpublished changes', async () => {
  const { root, store } = storeIn();
  await store.load();
  await store.publish('derek', store.state().revision);
  // Simulate files written by the previous version of the site (no photo fields at all).
  const strip = (c) => {
    delete c.hero.image;
    delete c.seo.shareImage;
    delete c.seo.siteUrl;
    delete c.gallery.source;
    delete c.gallery.photos;
    for (const item of c.flavors.items) delete item.image;
    return c;
  };
  const dir = path.join(root, 'admin', 'content');
  const pub = JSON.parse(fs.readFileSync(path.join(dir, 'published.json'), 'utf8'));
  strip(pub.content);
  fs.writeFileSync(path.join(dir, 'published.json'), JSON.stringify(pub));
  fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify({ revision: 3, content: strip(clone(pub.content)), savedAt: null, savedBy: null }));

  const upgraded = createContentStore({ dir, siteDir: path.join(root, 'site'), render: renderPage, photos: () => library() });
  await upgraded.load();
  assert.equal(upgraded.state().hasUnpublishedChanges, false);
  assert.equal((await upgraded.history()).filter((h) => h.live).length >= 1, true);
});
