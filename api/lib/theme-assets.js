'use strict';

// Files the published page links to: the theme stylesheet and icons made from the logo.
// Names include a content hash, so browsers can cache them for a long time and a new design
// never shows with an old stylesheet. A file is deleted only once it has been unused for a day,
// so visitors who still have the previous page open keep their styling.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { writeFileAtomic } = require('./store');
const { themeCss } = require('./theme');

const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

function createThemeAssets({ dir, uploadDir, publicPath = '/site-assets', now = () => Date.now() }) {
  // Files the previous build used. They are kept (and their clock restarted) for one more build, so
  // the countdown to deletion starts when a file stops being used, not when it was first created.
  let previous = new Set();

  async function ensureDir() {
    await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
    await fsp.chmod(dir, 0o755).catch(() => {});
  }

  const exists = (file) => fsp.access(file).then(() => true, () => false);

  async function writeOnce(name, makeData) {
    const file = path.join(dir, name);
    if (!(await exists(file))) await writeFileAtomic(file, await makeData(), 0o644);
    return `${publicPath}/${name}`;
  }

  async function prune(keep) {
    const recent = new Set([...keep, ...previous]);
    const stamp = new Date(now());
    for (const name of await fsp.readdir(dir)) {
      if (name.endsWith('.tmp')) continue;
      const file = path.join(dir, name);
      if (recent.has(name)) {
        await fsp.utimes(file, stamp, stamp).catch(() => {});
        continue;
      }
      const { mtimeMs } = await fsp.stat(file);
      if (now() - mtimeMs > PRUNE_AFTER_MS) await fsp.rm(file, { force: true });
    }
    previous = keep;
  }

  async function build(content, photos) {
    await ensureDir();
    const result = {};
    const keep = new Set();
    const css = themeCss(content.theme);
    if (css) {
      const name = `theme-${hash(css)}.css`;
      result.themeHref = await writeOnce(name, async () => css);
      keep.add(name);
    }
    const logo = content.theme.logo && photos ? photos.get(content.theme.logo) : null;
    if (logo) {
      const source = path.join(uploadDir, `${logo.id}-${logo.widths[logo.widths.length - 1]}.webp`);
      try {
        const small = `icon-${logo.id}-32.png`;
        result.iconHref = await writeOnce(small, () => sharp(source).resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
        keep.add(small);
        // Home-screen icons can't be transparent on iPhones, so they get the page background color.
        const background = content.theme.colors.background;
        const large = `icon-${logo.id}-180-${background.slice(1)}.png`;
        result.appleIconHref = await writeOnce(large, () => sharp(source)
          .resize(150, 150, { fit: 'contain', background })
          .extend({ top: 15, bottom: 15, left: 15, right: 15, background })
          .flatten({ background })
          .png().toBuffer());
        keep.add(large);
      } catch {
        // A missing or unreadable logo file falls back to the default icon rather than breaking publishing.
        delete result.iconHref;
        delete result.appleIconHref;
      }
    }
    await prune(keep);
    return result;
  }

  return { build };
}

module.exports = { createThemeAssets };
