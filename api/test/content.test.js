'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONTENT, V1_DEFAULT, normalizeContent, createContentStore, photoUsage } = require('../lib/content');
const { renderPage } = require('../lib/render');

const clone = (v) => JSON.parse(JSON.stringify(v));
// Ignore formatting-only differences: comments, whitespace and the escaped apostrophe.
const normalizeHtml = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').replace(/>\s+/g, '>').replace(/\s+</g, '<').trim();
const home = (c) => c.pages.find((p) => p.id === 'home');
const block = (c, id, pageId = 'home') => c.pages.find((p) => p.id === pageId).blocks.find((b) => b.id === id);
const render = (c, options) => renderPage(normalizeContent(c, options && options.photos ? { photos: options.photos } : {}).content, options);

function storeIn(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-content-'));
  let clock = 1_800_000_000_000;
  const store = createContentStore({ dir: path.join(root, 'admin', 'content'), siteDir: path.join(root, 'site'), render: renderPage, now: () => { clock += 1000; return clock; }, ...options });
  return { root, store };
}

function aboutPage(extra = {}) {
  return {
    id: 'about1', slug: 'about-us', title: 'About us',
    seo: { title: 'About us | Frosted Harmony', description: 'The story behind the cupcakes.', shareImage: '' },
    blocks: [
      { id: 'b1', type: 'hero', heading: 'Our story', lead: 'Baking since 2019.', primaryButton: { label: 'Order now', target: 'block:home:contact' }, secondaryButton: { label: '', target: '' } },
      { id: 'b2', type: 'text', heading: 'Who we are', body: 'First paragraph.\nSame paragraph.\n\nSecond paragraph.', button: { label: 'See flavors', target: 'block:home:flavors' } },
    ],
    ...extra,
  };
}

// ---------- The home page ----------

test('the default content renders exactly the original hand-written page', () => {
  const original = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'index.html'), 'utf8');
  assert.equal(normalizeHtml(renderPage(normalizeContent(DEFAULT_CONTENT).content)), normalizeHtml(original));
});

test('content saved before pages existed becomes the home page, unchanged', () => {
  const upgraded = normalizeContent(clone(V1_DEFAULT));
  assert.deepEqual(upgraded.errors, []);
  assert.deepEqual(upgraded.content, DEFAULT_CONTENT);

  const old = clone(V1_DEFAULT);
  old.order = ['ordering', 'flavors', 'gallery'];
  old.gallery.visible = false;
  old.hero.heading = 'Old heading';
  old.flavors.items[0].price = '$36 / dozen';
  delete old.hero.image;
  delete old.gallery.photos;
  const { content, errors } = normalizeContent(old);
  assert.deepEqual(errors, []);
  assert.deepEqual(home(content).blocks.map((b) => b.id), ['hero', 'ordering', 'flavors', 'gallery', 'contact']);
  assert.equal(block(content, 'gallery').visible, false);
  assert.equal(block(content, 'hero').heading, 'Old heading');
  assert.deepEqual(content.site.menu.map((m) => m.label), ['Ordering', 'Flavors', 'Gallery', 'Inquire']);
  const html = renderPage(content);
  assert.ok(!html.includes('id="gallery"') && !html.includes('href="#gallery"'), 'hidden sections leave the page and the menu');
  assert.ok(html.indexOf('id="ordering"') < html.indexOf('id="flavors"'));
  assert.ok(html.includes('<p class="card-price">$36 / dozen</p>'));
  // With the gallery hidden, the second banner button points at the first visible section, as before.
  assert.ok(html.includes('class="button button-outline" href="#ordering"'));
});

test('anything typed in is escaped, so it cannot add HTML or scripts', () => {
  const content = clone(DEFAULT_CONTENT);
  block(content, 'hero').heading = '<script>alert(1)</script>';
  block(content, 'flavors').items[0].name = '"><img src=x onerror=alert(1)>';
  content.site.brand.name = 'Tom & Jerry\'s "Bakery"';
  block(content, 'hero').lead = 'Line one\nLine <b>two</b>';
  content.site.menu[0].label = '<i>Menu</i>';
  const html = render(content);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('aria-label="Tom &amp; Jerry&#39;s &quot;Bakery&quot; home"'));
  assert.ok(html.includes('Line one<br>\nLine &lt;b&gt;two&lt;/b&gt;'));
  assert.ok(html.includes('&lt;i&gt;Menu&lt;/i&gt;'));
});

test('links must be a real Instagram https URL and a valid email', () => {
  const bad = clone(DEFAULT_CONTENT);
  bad.site.links.instagramUrl = 'javascript:alert(1)';
  bad.site.links.email = 'x" onclick="alert(1)';
  assert.equal(normalizeContent(bad).errors.length, 2);
  const lookalike = clone(DEFAULT_CONTENT);
  lookalike.site.links.instagramUrl = 'https://instagram.com.evil.example/x';
  assert.equal(normalizeContent(lookalike).errors.length, 1);
  const empty = clone(DEFAULT_CONTENT);
  empty.site.links.instagramUrl = '';
  assert.ok(!render(empty).includes('data-instagram-link'));
});

test('validation reports empty required fields, long text and too many items', () => {
  const content = clone(DEFAULT_CONTENT);
  block(content, 'hero').heading = '   ';
  home(content).seo.title = 'x'.repeat(71);
  block(content, 'flavors').items = Array.from({ length: 41 }, (_, i) => ({ name: `Flavor ${i}` }));
  block(content, 'ordering').items = [{ title: '', text: 'no title' }];
  const { errors } = normalizeContent(content);
  assert.equal(errors.length, 4, errors.join('\n'));
  assert.ok(errors.includes('Home page, Top banner: Main heading can\'t be empty.'));
  assert.ok(errors.includes('Home page, Steps, step 1: Title can\'t be empty.'));
  const invisible = clone(DEFAULT_CONTENT);
  block(invisible, 'hero').heading = ' \u0001\u0002 ';
  assert.match(normalizeContent(invisible).errors.join(' '), /Main heading can't be empty/, 'invisible characters do not count as text');
});

test('missing block fields take the defaults for that kind of block; unknown fields are dropped', () => {
  const content = clone(DEFAULT_CONTENT);
  content.pages.push({ id: 'new1', slug: 'new', title: 'New', seo: { title: 'New', description: 'New page' }, blocks: [{ id: 'x', type: 'steps', extra: 'nope' }] });
  const { content: result, errors } = normalizeContent(content);
  assert.deepEqual(errors, []);
  const steps = block(result, 'x', 'new1');
  assert.equal(steps.heading, 'How it works');
  assert.equal(steps.items.length, 1);
  assert.equal(steps.extra, undefined);
  assert.equal(steps.anchor, 'steps', 'a link name is given automatically');
});

test('preview pages are marked, not indexed, disable the form and can mark blocks', () => {
  const html = renderPage(normalizeContent(DEFAULT_CONTENT).content, { preview: true, markBlocks: true });
  assert.ok(html.includes('data-preview="1"'));
  assert.ok(html.includes('noindex'));
  assert.ok(html.includes('preview-banner'));
  assert.ok(html.includes('<section class="hero" data-block="hero">'));
  assert.ok(html.includes('<section id="contact" class="section section-tinted" data-block="contact">'));
});

// ---------- Pages, blocks, menu and links ----------

test('new pages: menu, links between pages, page-only content and the shared header and footer', () => {
  const content = clone(DEFAULT_CONTENT);
  content.pages.push(aboutPage());
  content.site.menu.splice(3, 0, { label: 'About', target: 'page:about1', style: 'link' });
  const { content: site, errors } = normalizeContent(content);
  assert.deepEqual(errors, []);

  const about = renderPage(site, { pageId: 'about1' });
  assert.ok(about.includes('<title>About us | Frosted Harmony</title>'));
  assert.ok(about.includes('<a href="/about-us" aria-current="page">About</a>'));
  assert.ok(about.includes('<a href="/#gallery">Gallery</a>'), 'home sections are linked with the home address');
  assert.ok(about.includes('<a href="/#contact" class="button button-small">Inquire</a>'));
  assert.ok(about.includes('<a class="brand" href="/"'), 'the logo goes back to the home page');
  assert.ok(about.includes('<h1>Our story</h1>'));
  assert.ok(about.includes('<a class="button" href="/#contact">Order now</a>'));
  assert.ok(about.includes('<p>First paragraph.<br>\nSame paragraph.</p>') && about.includes('<p>Second paragraph.</p>'));
  assert.ok(about.includes('<a class="button" href="/#flavors">See flavors</a>'));
  assert.ok(about.includes('<section id="text" class="section text-block section-tinted">'), 'the last section is tinted');
  assert.ok(!about.includes('inquiry-form'), 'no contact form on this page');
  assert.ok(about.includes('Baked with love.'), 'the footer is shared');

  const homeHtml = renderPage(site);
  assert.ok(homeHtml.includes('<a href="/about-us">About</a>'));
  assert.ok(homeHtml.includes('<a href="#gallery">Gallery</a>'), 'same-page links stay short');

  const preview = renderPage(site, { pageId: 'about1', preview: true, linkFor: (slug) => `/p/${slug}` });
  assert.ok(preview.includes('href="/p/#contact"') && preview.includes('href="/p/about-us"'), 'preview links stay inside the preview');
});

test('web addresses must be unique, valid and not used by the website itself', () => {
  for (const [slug, message] of [['About Us', /only a-z/], ['admin', /used by the website itself/], ['cdn-cgi', /used by the website itself/], ['-x', /only a-z/], ['', /only a-z/]]) {
    const content = clone(DEFAULT_CONTENT);
    content.pages.push(aboutPage({ slug }));
    assert.match(normalizeContent(content).errors.join(' '), message, slug);
  }
  const twice = clone(DEFAULT_CONTENT);
  twice.pages.push(aboutPage(), aboutPage({ id: 'about2' }));
  assert.match(normalizeContent(twice).errors.join(' '), /already uses the web address "\/about-us"/);
  const sameId = clone(DEFAULT_CONTENT);
  sameId.pages.push(aboutPage(), aboutPage({ slug: 'other' }));
  assert.match(normalizeContent(sameId).errors.join(' '), /invalid page id/);
  const noHome = clone(DEFAULT_CONTENT);
  noHome.pages = [aboutPage()];
  assert.match(normalizeContent(noHome).errors.join(' '), /home page is missing/);
});

test('blocks: link names, one gallery and one contact form per page, valid kinds and ids, block limit', () => {
  const content = clone(DEFAULT_CONTENT);
  const page = aboutPage();
  page.blocks.push(
    { id: 'c1', type: 'contact' }, { id: 'c2', type: 'contact' },
    { id: 't1', type: 'text', anchor: 'top', heading: 'x' }, { id: 't2', type: 'text', anchor: 'Bad Name', heading: 'x' },
    { id: 't3', type: 'text', anchor: 'story', heading: 'x' }, { id: 't4', type: 'text', anchor: 'story', heading: 'x' },
    { id: 't5', type: 'text', heading: '', body: '' }, { id: 'x1', type: 'video' }, { id: 'BAD!', type: 'text', heading: 'x' },
  );
  content.pages.push(page);
  const errors = normalizeContent(content).errors.join('\n');
  assert.match(errors, /only one contact form block/);
  assert.match(errors, /link name "top" is used by the page itself/);
  assert.match(errors, /link name must start with a letter/);
  assert.match(errors, /two blocks use the link name "story"/);
  assert.match(errors, /add a heading or some text/);
  assert.match(errors, /unknown kind of block/);
  assert.match(errors, /invalid block id/);

  const many = clone(DEFAULT_CONTENT);
  many.pages.push(aboutPage({ blocks: Array.from({ length: 31 }, (_, i) => ({ id: `t${i}`, type: 'text', heading: 'x' })) }));
  assert.match(normalizeContent(many).errors.join(' '), /at most 30 blocks/);
});

test('links to missing pages or blocks are errors when saving and quietly dropped for old versions', () => {
  const content = clone(DEFAULT_CONTENT);
  content.site.menu.push({ label: 'Gone', target: 'page:nothere', style: 'link' });
  block(content, 'hero').secondaryButton.target = 'block:home:nothere';
  content.site.menu.push({ label: 'Bad', target: 'javascript:alert(1)', style: 'link' });
  const strict = normalizeContent(content);
  assert.match(strict.errors.join(' '), /Menu item 5 \("Gone"\): the page or block it links to no longer exists/);
  assert.match(strict.errors.join(' '), /Second button: the page or block it links to no longer exists/);
  assert.match(strict.errors.join(' '), /Menu item 6 \("Bad"\): invalid link/);
  content.site.menu.pop();
  const lenient = normalizeContent(content, { missingPhotos: 'drop' });
  assert.deepEqual(lenient.errors, []);
  assert.ok(!lenient.content.site.menu.some((m) => m.label === 'Gone'));
  assert.equal(block(lenient.content, 'hero').secondaryButton.target, '');
});

test('buttons to hidden blocks, Instagram and email; photo and text blocks; background choices', () => {
  const content = clone(DEFAULT_CONTENT);
  block(content, 'gallery').visible = false;
  home(content).blocks.splice(1, 0,
    { id: 'it', type: 'imageText', heading: 'Meet the baker', body: 'Hello.', imageSide: 'left', background: 'tinted', button: { label: 'Follow', target: 'instagram' } },
    { id: 'tx', type: 'text', heading: 'Note', body: 'Hi', background: 'plain', button: { label: 'Write', target: 'email' } });
  const html = render(content);
  assert.ok(!html.includes('See our cupcakes'), 'a button to a hidden block is left out');
  assert.ok(html.includes('<section id="photo-text" class="section section-tinted">'));
  assert.ok(html.includes('class="container split split-no-photo split-photo-left"'));
  assert.ok(html.includes('<a class="button" href="https://www.instagram.com/frostedharmony/">Follow</a>'));
  assert.ok(html.includes('<a class="button" href="mailto:cupcakes@frostedharmony.com">Write</a>'));
  assert.ok(html.includes('<section id="text" class="section text-block">'), 'plain stays plain');
});

test('the website address must be a plain https address', () => {
  for (const bad of ['http://frostedharmony.com', 'https://frostedharmony.com/path', 'javascript:alert(1)', 'https://user@frostedharmony.com']) {
    const content = clone(DEFAULT_CONTENT);
    content.site.siteUrl = bad;
    assert.equal(normalizeContent(content).errors.length, 1, bad);
  }
  const ok = clone(DEFAULT_CONTENT);
  ok.site.siteUrl = 'https://FrostedHarmony.com/';
  assert.equal(normalizeContent(ok).content.site.siteUrl, 'https://frostedharmony.com');
});

// ---------- The store ----------

test('draft, publish, history, restore and discard', async () => {
  const { root, store } = storeIn();
  await store.load();
  assert.equal(store.state().published, null);
  assert.equal(store.state().hasUnpublishedChanges, false);
  assert.equal(fs.existsSync(path.join(root, 'site', 'index.html')), false);

  const edited = clone(store.state().draft);
  block(edited, 'hero').heading = 'Version one';
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
  block(second, 'hero').heading = 'Version two';
  await store.saveDraft(second, store.state().revision, 'wife');
  await store.publish('wife', store.state().revision);
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes('Version two'));

  history = await store.history();
  const original = history.find((h) => h.label === 'original');
  assert.equal((await store.restore(original.id, { revision: store.state().revision }, 'derek')).ok, true);
  assert.equal(block(store.state().draft, 'hero').heading, block(DEFAULT_CONTENT, 'hero').heading);
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes('Version two'), 'restore to draft must not publish');

  await store.discard('derek');
  assert.equal(block(store.state().draft, 'hero').heading, 'Version two');

  const firstVersion = (await store.history()).find((h) => h.label === 'published' && !h.live);
  assert.equal((await store.restore(firstVersion.id, { publish: true }, 'derek')).ok, true);
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes('Version one'));

  assert.equal((await store.restore('../../etc/passwd', {}, 'x')).status, 400);
  assert.equal((await store.restore('123-nothere', {}, 'x')).status, 404);
});

test('publishing writes every page and removes deleted ones; old versions bring their pages back', async () => {
  const { root, store } = storeIn();
  await store.load();
  const pagesDir = path.join(root, 'site', 'pages');
  const withAbout = clone(store.state().draft);
  withAbout.pages.push(aboutPage(), aboutPage({ id: 'menu1', slug: 'menu', title: 'Menu' }));
  assert.equal((await store.saveDraft(withAbout, 0, 'derek')).ok, true);
  await store.publish('derek', store.state().revision);
  assert.deepEqual(fs.readdirSync(pagesDir).sort(), ['about-us.html', 'menu.html']);
  assert.ok(fs.readFileSync(path.join(pagesDir, 'about-us.html'), 'utf8').includes('<h1>Our story</h1>'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(pagesDir, 'menu.html')).mode & 0o777, 0o644);

  const withoutMenu = clone(store.state().draft);
  withoutMenu.pages = withoutMenu.pages.filter((p) => p.id !== 'menu1');
  withoutMenu.pages[1].slug = 'our-story';
  await store.saveDraft(withoutMenu, store.state().revision, 'derek');
  await store.publish('derek', store.state().revision);
  assert.deepEqual(fs.readdirSync(pagesDir), ['our-story.html'], 'removed and renamed pages disappear');

  const older = (await store.history()).find((h) => h.label === 'published' && !h.live);
  await store.restore(older.id, { publish: true }, 'derek');
  assert.deepEqual(fs.readdirSync(pagesDir).sort(), ['about-us.html', 'menu.html']);
  const original = (await store.history()).find((h) => h.label === 'original');
  await store.restore(original.id, { publish: true }, 'derek');
  assert.deepEqual(fs.readdirSync(pagesDir), []);
});

test('a save based on an old revision is refused, even when two arrive at once', async () => {
  const { store } = storeIn();
  await store.load();
  const a = clone(store.state().draft);
  block(a, 'hero').heading = 'From Derek';
  const b = clone(store.state().draft);
  block(b, 'hero').heading = 'From his wife';
  const results = await Promise.all([store.saveDraft(a, 0, 'derek'), store.saveDraft(b, 0, 'wife')]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.equal(results.find((r) => !r.ok).status, 409);
});

test('a publish based on an old revision is refused, even when a save is still being written', async () => {
  const { store } = storeIn();
  await store.load();
  const seen = store.state().revision;
  const edited = clone(store.state().draft);
  block(edited, 'hero').heading = 'Saved by the other admin, never previewed';
  const [saved, published] = await Promise.all([store.saveDraft(edited, seen, 'wife'), store.publish('derek', seen)]);
  assert.equal(saved.ok, true);
  assert.equal(published.status, 409);
  assert.equal(store.state().published, null);
});

test('"put back live" publishes an old version without touching the shared draft', async () => {
  const { root, store } = storeIn();
  await store.load();
  const first = clone(store.state().draft);
  block(first, 'hero').heading = 'Live version';
  await store.saveDraft(first, store.state().revision, 'derek');
  await store.publish('derek', store.state().revision);

  const work = clone(store.state().draft);
  block(work, 'hero').heading = 'Unfinished work by the other admin';
  await store.saveDraft(work, store.state().revision, 'wife');
  const revisionBefore = store.state().revision;

  const original = (await store.history()).find((h) => h.label === 'original');
  assert.equal((await store.restore(original.id, { publish: true }, 'derek')).ok, true);
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes(block(DEFAULT_CONTENT, 'hero').heading));
  assert.equal(block(store.state().draft, 'hero').heading, 'Unfinished work by the other admin');
  assert.equal(store.state().revision, revisionBefore);
  assert.equal((await store.restore(original.id, { revision: revisionBefore - 1 }, 'derek')).status, 409);
});

test('invalid drafts are not saved', async () => {
  const { store } = storeIn();
  await store.load();
  const bad = clone(store.state().draft);
  bad.site.brand.name = '';
  const result = await store.saveDraft(bad, 0, 'derek');
  assert.equal(result.status, 400);
  assert.equal(store.state().revision, 0);
});

test('history keeps the newest 30 versions plus the original', async () => {
  const { store } = storeIn();
  await store.load();
  for (let i = 0; i < 33; i += 1) {
    const next = clone(store.state().draft);
    block(next, 'hero').heading = `Version ${i}`;
    await store.saveDraft(next, store.state().revision, 'derek');
    await store.publish('derek', store.state().revision);
  }
  const history = await store.history();
  assert.equal(history.length, 31);
  assert.equal(history.filter((h) => h.label === 'original').length, 1);
});

test('state survives a restart and the live pages are regenerated', async () => {
  const { root, store } = storeIn();
  await store.load();
  const next = clone(store.state().draft);
  block(next, 'hero').heading = 'Persisted heading';
  next.pages.push(aboutPage());
  await store.saveDraft(next, 0, 'derek');
  await store.publish('derek', store.state().revision);
  fs.rmSync(path.join(root, 'site', 'index.html'));
  fs.rmSync(path.join(root, 'site', 'pages', 'about-us.html'));

  const again = createContentStore({ dir: path.join(root, 'admin', 'content'), siteDir: path.join(root, 'site'), render: renderPage });
  await again.load();
  await again.regenerate();
  assert.equal(block(again.state().draft, 'hero').heading, 'Persisted heading');
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes('Persisted heading'));
  assert.ok(fs.existsSync(path.join(root, 'site', 'pages', 'about-us.html')));
});

test('drafts and published versions saved before pages existed load without "unpublished changes"', async () => {
  const { root, store } = storeIn();
  await store.load();
  const dir = path.join(root, 'admin', 'content');
  const old = clone(V1_DEFAULT);
  old.hero.heading = 'Published before the upgrade';
  fs.writeFileSync(path.join(dir, 'published.json'), JSON.stringify({ content: old, at: '2026-01-01T00:00:00.000Z', by: 'derek' }));
  fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify({ revision: 3, content: clone(old), savedAt: null, savedBy: null }));
  fs.writeFileSync(path.join(dir, 'history', '1700000000000-old.json'), JSON.stringify({ id: '1700000000000-old', at: '2026-01-01T00:00:00.000Z', by: 'derek', label: 'published', content: old }));

  const upgraded = createContentStore({ dir, siteDir: path.join(root, 'site'), render: renderPage });
  await upgraded.load();
  assert.equal(upgraded.state().hasUnpublishedChanges, false);
  assert.equal(block(upgraded.state().draft, 'hero').heading, 'Published before the upgrade');
  assert.equal((await upgraded.history()).find((h) => h.id === '1700000000000-old').live, true);
  assert.equal((await upgraded.restore('1700000000000-old', { revision: 3 }, 'derek')).ok, true);
});

// ---------- Photos ----------

const PHOTO_A = 'AAAAAAAAAAAAAAAA';
const PHOTO_B = 'BBBBBBBBBBBBBBBB';
const library = (alts = {}) => new Map([
  [PHOTO_A, { id: PHOTO_A, alt: alts.a === undefined ? 'Red velvet "cupcakes" <3' : alts.a, width: 3000, height: 2000, widths: [400, 800, 1600] }],
  [PHOTO_B, { id: PHOTO_B, alt: alts.b === undefined ? 'Lemon cupcakes' : alts.b, width: 600, height: 900, widths: [400, 600] }],
]);

test('photo references must exist; old versions quietly drop deleted photos', () => {
  const content = clone(DEFAULT_CONTENT);
  block(content, 'hero').image = PHOTO_A;
  block(content, 'gallery').photos = [PHOTO_A, 'CCCCCCCCCCCCCCCC', PHOTO_A, '../../etc/passwd'];
  block(content, 'flavors').items[0].image = 'CCCCCCCCCCCCCCCC';
  const strict = normalizeContent(content, { photos: library() });
  assert.equal(strict.errors.length, 3);
  const lenient = normalizeContent(content, { photos: library(), missingPhotos: 'drop' });
  assert.equal(lenient.errors.length, 1, 'a malformed id is always an error');
  assert.deepEqual(block(lenient.content, 'gallery').photos, [PHOTO_A], 'missing photos dropped, duplicates removed');
  assert.equal(block(lenient.content, 'flavors').items[0].image, '');
  assert.equal(block(lenient.content, 'hero').image, PHOTO_A);
});

test('photos render as responsive, escaped images; link previews use absolute URLs', () => {
  const content = clone(DEFAULT_CONTENT);
  block(content, 'hero').image = PHOTO_A;
  block(content, 'gallery').photos = [PHOTO_B, PHOTO_A];
  block(content, 'flavors').items[0].image = PHOTO_B;
  home(content).seo.shareImage = PHOTO_A;
  const html = render(content, { photos: library() });
  assert.ok(html.includes(`srcset="/uploads/${PHOTO_A}-400.webp 400w, /uploads/${PHOTO_A}-800.webp 800w, /uploads/${PHOTO_A}-1600.webp 1600w"`));
  assert.ok(html.includes('width="1600" height="1067"'), 'reserves space using the aspect ratio');
  assert.ok(html.includes('alt="Red velvet &quot;cupcakes&quot; &lt;3"'));
  assert.ok(html.includes('class="hero-photo"') && html.includes('fetchpriority="high"'));
  assert.ok(!html.includes('cupcake-illustration'), 'the drawing is replaced by the photo');
  assert.ok(html.indexOf(`/uploads/${PHOTO_B}-600.webp`) < html.indexOf(`/uploads/${PHOTO_A}-800.webp" srcset`, html.indexOf('gallery-grid')), 'gallery keeps the chosen order');
  assert.ok(html.includes('class="card card-with-photo"'));
  assert.ok(html.includes(`<meta property="og:image" content="https://frostedharmony.com/uploads/${PHOTO_A}-share.jpg">`));
  assert.ok(html.includes('<meta property="og:url" content="https://frostedharmony.com/">'));
  assert.ok(!html.includes('Loading photos...'), 'own photos replace the loading message');
  assert.ok(!html.includes('data-gallery-source'), 'the default "mixed" mode needs no attribute');

  block(content, 'gallery').source = 'instagram';
  const igOnly = render(content, { photos: library() });
  assert.ok(igOnly.includes('data-gallery-source="instagram"'));
  assert.ok(!igOnly.includes('class="gallery-photo"'), 'own gallery photos are not shown in Instagram-only mode');
  assert.ok(igOnly.includes('Loading photos...'));
});

test('photoUsage lists every place a photo appears, on every page', () => {
  const content = clone(DEFAULT_CONTENT);
  block(content, 'hero').image = PHOTO_A;
  block(content, 'gallery').photos = [PHOTO_A];
  block(content, 'flavors').items[5].image = PHOTO_A;
  home(content).seo.shareImage = PHOTO_B;
  const about = aboutPage();
  about.blocks.push({ id: 'it', type: 'imageText', heading: 'x', image: PHOTO_B });
  content.pages.push(about);
  const usage = photoUsage(normalizeContent(content).content);
  assert.deepEqual(usage.get(PHOTO_A), ['Home page: Top banner', 'Home page: Gallery', 'Home page: Flavor cards, Red Velvet']);
  assert.deepEqual(usage.get(PHOTO_B), ['Home page: link preview', 'About us page: Photo and text']);
  assert.deepEqual(photoUsage(clone(V1_DEFAULT)), new Map(), 'old content is understood too');
});

test('publishing requires a description on every photo used', async () => {
  let photos = library({ a: '' });
  const { root, store } = storeIn({ photos: () => photos });
  await store.load();
  const next = clone(store.state().draft);
  block(next, 'gallery').photos = [PHOTO_A];
  assert.equal((await store.saveDraft(next, 0, 'derek')).ok, true, 'drafts may use undescribed photos');
  const blocked = await store.publish('derek', store.state().revision);
  assert.equal(blocked.status, 400);
  assert.match(blocked.error, /Home page: Gallery needs a description/);
  photos = library();
  assert.equal((await store.publish('derek', store.state().revision)).ok, true);
  assert.ok(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8').includes(`/uploads/${PHOTO_A}-400.webp`));
  assert.deepEqual(store.usage(PHOTO_A), ['Home page: Gallery']);
  assert.deepEqual(store.usage(PHOTO_B), []);
});
