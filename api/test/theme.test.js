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

// ---------- Dark mode ----------

test('the automatic dark colors are readable for every preset and for unusual colors', () => {
  const extra = ['#0000ff', '#777777', '#ffff00', '#00ff00', '#000000', '#ffffff', '#123456'];
  const palettes = [...Object.values(theme.PRESETS).map((p) => p.colors), ...extra.map((primary) => ({ ...theme.DEFAULT_THEME.colors, primary }))];
  for (const colors of palettes) {
    const dark = theme.deriveDark(colors);
    const failing = theme.contrastChecks(dark, true).filter((c) => !c.ok);
    assert.deepEqual(failing, [], `${colors.primary}`);
    assert.ok(Object.values(dark).every((v) => /^#[0-9a-f]{6}$/.test(v)));
  }
});

test('site/styles.css contains exactly the dark-mode rules the original design generates', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
  const block = css.slice(css.indexOf('/* dark-mode:start */\n') + '/* dark-mode:start */\n'.length, css.indexOf('/* dark-mode:end */'));
  assert.equal(block, theme.darkCss(theme.darkPalette(theme.DEFAULT_THEME)));
});

test('a custom design brings its own dark-mode rules, after the light ones', () => {
  const css = theme.themeCss(custom({ colors: { ...theme.PRESETS.mint.colors } }));
  const dark = theme.deriveDark(theme.PRESETS.mint.colors);
  assert.ok(css.indexOf(':root {') < css.indexOf('@media (prefers-color-scheme: dark)'));
  assert.ok(css.includes(`--pink-strong: ${dark.primary};`));
  assert.ok(css.includes(':root[data-color-mode="dark"]:not([data-dark="off"]) {'));
  const own = theme.themeCss(custom({ darkColors: { ...dark, primary: '#88ccaa' } }));
  assert.ok(own && own.includes('--pink-strong: #88ccaa;'), 'own dark colors alone need a stylesheet');
});

test('dark mode can be turned off; own dark colors are checked for readability', () => {
  assert.equal(theme.themeCss(custom({ darkMode: 'off' })), null, 'turning dark mode off needs no stylesheet');
  const off = renderPage(normalizeContent({ ...clone(DEFAULT_CONTENT), theme: { darkMode: 'off' } }).content);
  assert.ok(off.includes('<html lang="en" data-dark="off">'));
  assert.ok(!off.includes('data-mode-toggle'));
  const on = renderPage(normalizeContent(DEFAULT_CONTENT).content);
  assert.ok(on.includes('<html lang="en">') && on.includes('data-mode-toggle'));
  assert.ok(on.indexOf('<script src="/theme-mode.js"></script>') < on.indexOf('/styles.css'), 'mode script runs before the page is drawn');

  const unreadable = theme.normalizeTheme({ darkColors: { text: '#333333' } });
  assert.ok(unreadable.errors.some((e) => /^Dark mode colors are hard to read: main text on the page background/.test(e)));
  const partial = theme.normalizeTheme({ darkColors: { primary: '#ee7799' } });
  assert.deepEqual(partial.errors, []);
  assert.equal(partial.theme.darkColors.primary, '#ee7799');
  assert.equal(partial.theme.darkColors.background, theme.deriveDark(theme.DEFAULT_THEME.colors).background, 'missing colors come from the automatic palette');
  assert.deepEqual(theme.normalizeTheme({ darkColors: { text: '#333333' }, darkMode: 'off' }).errors, [], 'unused dark colors do not block saving');
  assert.ok(theme.normalizeTheme({ darkMode: 'sometimes' }).errors.includes('Dark mode: unknown choice.'));
  assert.ok(theme.normalizeTheme({ darkColors: { primary: 'red' } }).errors.length);
  assert.ok(theme.normalizeTheme({ darkColors: 'dark' }).errors.length);
});