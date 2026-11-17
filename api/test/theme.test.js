'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const theme = require('../lib/theme');
const { createThemeAssets } = require('../lib/theme-assets');
const { DEFAULT_CONTENT, normalizeContent, createContentStore } = require('../lib/content');
const { renderPage } = require('../lib/render');

const clone = (v) => JSON.parse(JSON.stringify(v));
const custom = (overrides = {}) => ({ ...clone(theme.DEFAULT_THEME), ...overrides });

test('the default design adds nothing to the page', () => {
  assert.equal(theme.themeCss(theme.DEFAULT_THEME), null);
  assert.equal(theme.isDefaultLook({ ...clone(theme.DEFAULT_THEME), logo: 'AAAAAAAAAAAAAAAA' }), true, 'a logo alone needs no stylesheet');
  const html = renderPage(normalizeContent(DEFAULT_CONTENT).content);
  assert.ok(!html.includes('/site-assets/'));
});

test('the original colors pass, with a warning only on the buttons', () => {
  const checks = theme.contrastChecks(theme.DEFAULT_THEME.colors);
  assert.ok(checks.every((c) => c.ok));
  const warnings = checks.filter((c) => c.recommended && c.ratio < c.recommended).map((c) => c.label);
  assert.deepEqual(warnings, ['Button text', 'Outline button on the page background']);
  assert.equal(checks.find((c) => c.label === 'Main text on the page background').ratio, 11.85);
});

test('every preset is readable', () => {
  for (const [key, preset] of Object.entries(theme.PRESETS)) {
    const { errors } = theme.normalizeTheme({ colors: preset.colors });
    assert.deepEqual(errors, [], key);
  }
});

test('unreadable colors, bad values and unknown choices are refused', () => {
  const pale = theme.normalizeTheme({ colors: { textSoft: '#dddddd' } });
  assert.ok(pale.errors.some((e) => /hard to read: secondary text on the page background/i.test(e)));

  const yellowButtons = theme.normalizeTheme({ colors: { primary: '#ffe36b', primaryDark: '#7a5500' } });
  assert.equal(theme.onPrimary({ ...theme.DEFAULT_THEME.colors, primary: '#ffe36b' }), theme.DEFAULT_THEME.colors.text, 'light buttons get dark text');
  assert.ok(!yellowButtons.errors.some((e) => /button text has/i.test(e)));

  for (const bad of ['red', '#fff', 'red;}body{display:none', '#12345g', '', null]) {
    const { errors, theme: result } = theme.normalizeTheme({ colors: { primary: bad } });
    assert.ok(errors.length, String(bad));
    assert.equal(result.colors.primary, theme.DEFAULT_THEME.colors.primary);
  }
  const fonts = theme.normalizeTheme({ headingFont: 'comic-sans', bodyFont: '"x"; } body { color: red', corners: 'blob', buttons: 'star' });
  assert.equal(fonts.errors.length, 4);
  assert.equal(fonts.theme.headingFont, 'georgia');
});

test('the generated stylesheet only contains validated values and the fonts in use', () => {
  const css = theme.themeCss(custom({ headingFont: 'playfair', bodyFont: 'nunito', corners: 'round', buttons: 'square', colors: { ...theme.PRESETS.lavender.colors } }));
  assert.match(css, /--pink-strong: #7b4fb3;/);
  assert.match(css, /--radius: 24px;/);
  assert.match(css, /--button-radius: 4px;/);
  assert.match(css, /--serif: "Playfair Display", Georgia, serif;/);
  assert.match(css, /url\("\/fonts\/playfair-display\.woff2"\)/);
  assert.match(css, /url\("\/fonts\/nunito\.woff2"\)/);
  assert.ok(!css.includes('pacifico') && !css.includes('lora.woff2'));
  for (const file of ['playfair-display', 'nunito', 'lora', 'pacifico', 'dm-serif-display', 'open-sans', 'source-sans-3']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'site', 'fonts', `${file}.woff2`)), `${file}.woff2 is bundled`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'site', 'fonts', 'licenses', `${file}.txt`)), `${file} license is bundled`);
  }
});

test('the page links the stylesheet, icons and logo when they exist', () => {
  const logoId = 'LLLLLLLLLLLLLLLL';
  const photos = new Map([[logoId, { id: logoId, alt: 'Frosted Harmony logo', width: 600, height: 300, widths: [400, 600] }]]);
  const content = clone(DEFAULT_CONTENT);
  content.theme.logo = logoId;
  const html = renderPage(normalizeContent(content, { photos }).content, {
    photos, assets: { themeHref: '/site-assets/theme-abc.css', iconHref: '/site-assets/icon-32.png', appleIconHref: '/site-assets/icon-180.png' },
  });
  assert.ok(html.includes('<link rel="stylesheet" href="/styles.css">\n  <link rel="stylesheet" href="/site-assets/theme-abc.css">'), 'theme loads after the base styles');
  assert.ok(html.includes('<link rel="icon" href="/site-assets/icon-32.png" type="image/png" sizes="32x32">'));
  assert.ok(html.includes('<link rel="apple-touch-icon" href="/site-assets/icon-180.png">'));
  assert.ok(html.includes(`<img class="brand-logo" src="/uploads/${logoId}-400.webp" alt="" width="400" height="200">`));
  assert.ok(!html.includes('href="/images/favicon.svg"'));
});

async function setupAssets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-theme-'));
  const uploadDir = path.join(root, 'uploads');
  fs.mkdirSync(uploadDir);
  let clock = Date.now();
  const assets = createThemeAssets({ dir: path.join(root, 'site', 'assets'), uploadDir, now: () => clock });
  return { root, uploadDir, assets, tick: (ms) => { clock += ms; } };
}

test('publishing a design writes hashed files and removes them a day after they stop being used', async () => {
  const { root, assets, tick } = await setupAssets();
  const build = (preset) => assets.build(normalizeContent({ theme: { colors: theme.PRESETS[preset].colors } }).content, new Map());
  const fileOf = (href) => path.join(root, 'site', href.replace('/site-assets/', 'assets/'));
  const day = 24 * 60 * 60 * 1000;

  const a = await build('mint');
  assert.match(a.themeHref, /^\/site-assets\/theme-[0-9a-f]{12}\.css$/);
  assert.ok(fs.readFileSync(fileOf(a.themeHref), 'utf8').includes('--pink-strong: #2a7d55;'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(fileOf(a.themeHref)).mode & 0o777, 0o644);
  assert.deepEqual(await build('mint'), a, 'same design, same file name');

  // Design A has been live for 5 days when design B replaces it.
  tick(5 * day);
  const b = await build('lavender');
  assert.notEqual(b.themeHref, a.themeHref);
  assert.ok(fs.existsSync(fileOf(a.themeHref)), 'the stylesheet that was live until now is kept for pages already open');
  tick(60 * 60 * 1000);
  await build('chocolate');
  assert.ok(fs.existsSync(fileOf(a.themeHref)), 'still kept an hour after it stopped being used');
  assert.ok(fs.existsSync(fileOf(b.themeHref)));
  tick(day + 60 * 60 * 1000);
  await build('chocolate');
  assert.equal(fs.existsSync(fileOf(a.themeHref)), false, 'removed once unused for more than a day');
  assert.equal(fs.existsSync(fileOf(b.themeHref)), false);

  const plain = await assets.build(normalizeContent(DEFAULT_CONTENT).content, new Map());
  assert.deepEqual(plain, {});
});

test('a logo becomes a browser icon and an opaque home-screen icon', async () => {
  const { root, uploadDir, assets } = await setupAssets();
  const id = 'LLLLLLLLLLLLLLLL';
  await sharp({ create: { width: 600, height: 300, channels: 4, background: { r: 217, g: 79, b: 107, alpha: 0.5 } } }).webp().toFile(path.join(uploadDir, `${id}-600.webp`));
  const photos = new Map([[id, { id, alt: 'Logo', width: 600, height: 300, widths: [400, 600] }]]);
  const content = normalizeContent({ theme: { logo: id } }, { photos }).content;
  const result = await assets.build(content, photos);
  assert.equal(result.themeHref, undefined, 'a logo alone needs no stylesheet');
  const small = await sharp(path.join(root, 'site', 'assets', `icon-${id}-32.png`)).metadata();
  assert.deepEqual([small.width, small.height, small.format, small.hasAlpha], [32, 32, 'png', true]);
  const large = await sharp(path.join(root, 'site', 'assets', result.appleIconHref.split('/').pop())).metadata();
  assert.deepEqual([large.width, large.height, large.hasAlpha], [180, 180, false]);

  const missing = new Map([['MMMMMMMMMMMMMMMM', { id: 'MMMMMMMMMMMMMMMM', alt: 'x', width: 500, height: 500, widths: [400, 500] }]]);
  const noFile = await assets.build(normalizeContent({ theme: { logo: 'MMMMMMMMMMMMMMMM' } }, { photos: missing }).content, missing);
  assert.deepEqual(noFile, {}, 'an unreadable logo falls back to the default icon');
});

test('publishing with a design links the generated stylesheet; the logo counts as a used photo', async () => {
  const { root, uploadDir, assets } = await setupAssets();
  const id = 'LLLLLLLLLLLLLLLL';
  await sharp({ create: { width: 400, height: 400, channels: 3, background: '#d94f6b' } }).webp().toFile(path.join(uploadDir, `${id}-400.webp`));
  const photos = new Map([[id, { id, alt: '', width: 400, height: 400, widths: [400] }]]);
  const store = createContentStore({
    dir: path.join(root, 'admin', 'content'), siteDir: path.join(root, 'site'), render: renderPage,
    photos: () => photos, assets: (c) => assets.build(c, photos),
  });
  await store.load();
  const next = clone(store.state().draft);
  next.theme = { ...next.theme, colors: theme.PRESETS.chocolate.colors, logo: id, buttons: 'rounded' };
  assert.equal((await store.saveDraft(next, 0, 'derek')).ok, true);
  assert.deepEqual(store.usage(id), ['Logo']);
  const blocked = await store.publish('derek', store.state().revision);
  assert.match(blocked.error, /Logo needs a description/, 'every photo used, including the logo, needs a description');
  photos.get(id).alt = 'Frosted Harmony logo';
  assert.equal((await store.publish('derek', store.state().revision)).ok, true);
  const page = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8');
  const href = /<link rel="stylesheet" href="(\/site-assets\/theme-[0-9a-f]{12}\.css)">/.exec(page)[1];
  assert.ok(fs.readFileSync(path.join(root, 'site', href.replace('/site-assets/', 'assets/')), 'utf8').includes('--button-radius: 12px;'));
  assert.ok(page.includes(`/site-assets/icon-${id}-32.png`));

  const unreadable = clone(store.state().draft);
  unreadable.theme.colors.text = '#eeeeee';
  const refused = await store.saveDraft(unreadable, store.state().revision, 'derek');
  assert.equal(refused.status, 400);
  assert.match(refused.error, /hard to read/);
});
