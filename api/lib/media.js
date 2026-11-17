'use strict';

// Photo library. Uploads are decoded and re-encoded with sharp, which:
//  - proves the file really is a JPEG/PNG/WebP (nothing is trusted from the name or Content-Type),
//  - applies the camera's rotation, then drops ALL metadata (EXIF, GPS location, camera serials),
//  - resizes to a few web sizes in WebP plus a 1200x630 JPEG for link previews.
// Originals are not kept.

const fsp = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { readJson, writeJson, writeFileAtomic } = require('./store');
const { randomToken } = require('./crypto');

sharp.cache(false);
sharp.concurrency(1);

const WIDTHS = [400, 800, 1600];
const SHARE = { width: 1200, height: 630 };
const LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  // Refuse images with more pixels than this before decoding them ("decompression bombs").
  maxPixels: 50_000_000,
  minSide: 200,
  maxPhotos: 500,
  maxAlt: 250,
};
const ACCEPTED = new Set(['jpeg', 'png', 'webp']);
const ID = /^[A-Za-z0-9]{16}$/;

function newId() {
  let id = '';
  while (id.length < 16) id += randomToken(16).replace(/[^A-Za-z0-9]/g, '');
  return id.slice(0, 16);
}

class PhotoError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Returns the processed outputs without writing anything. Throws PhotoError for unusable files.
async function processImage(buffer, limits = LIMITS) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new PhotoError('The file is empty.');
  if (buffer.length > limits.maxBytes) throw new PhotoError(`Photos can be at most ${Math.round(limits.maxBytes / 1048576)} MB.`, 413);

  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: limits.maxPixels, failOn: 'error' }).metadata();
  } catch (err) {
    if (/pixel limit/i.test(err.message)) throw new PhotoError('That image is too large (too many pixels). Please use a normal photo.');
    throw new PhotoError('That file is not a photo this site can use. Please upload a JPEG, PNG or WebP image.');
  }
  if (meta.format === 'heif') {
    throw new PhotoError('iPhone HEIC photos can\'t be read here. Upload from the iPhone\'s browser (it converts to JPEG automatically) or export the photo as JPEG.');
  }
  if (!ACCEPTED.has(meta.format)) throw new PhotoError('Please upload a JPEG, PNG or WebP image.');
  if ((meta.pages || 1) > 1) throw new PhotoError('Animated images aren\'t supported. Please upload a still photo.');

  const base = () => sharp(buffer, { limitInputPixels: limits.maxPixels, failOn: 'error' }).rotate();
  // EXIF orientations 5-8 mean the camera stored the photo sideways, so width and height swap.
  const sideways = (meta.orientation || 1) >= 5;
  const width = sideways ? meta.height : meta.width;
  const height = sideways ? meta.width : meta.height;
  if (!width || !height) throw new PhotoError('That photo appears to be damaged and couldn\'t be read.');
  if (Math.min(width, height) < limits.minSide) throw new PhotoError(`That image is too small. Use one at least ${limits.minSide} pixels on each side.`);

  // Every output is re-encoded from decoded pixels; sharp writes no metadata unless asked to.
  const widths = WIDTHS.filter((w) => w < width);
  widths.push(Math.min(width, WIDTHS[WIDTHS.length - 1]));
  const variants = [];
  try {
    for (const w of [...new Set(widths)].sort((a, b) => a - b)) {
      const data = await base().resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      variants.push({ width: w, data });
    }
    const share = await base().resize(SHARE.width, SHARE.height, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    return { width, height, variants, share };
  } catch {
    throw new PhotoError('That photo appears to be damaged and couldn\'t be read.');
  }
}

const variantFile = (id, width) => `${id}-${width}.webp`;
const shareFile = (id) => `${id}-share.jpg`;

function createMediaStore({ metaFile, uploadDir, limits = LIMITS, now = () => Date.now() }) {
  let photos = [];
  let queue = Promise.resolve();
  const exclusive = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  async function load() {
    // nginx (a different user) serves these files, so the folder and files are world-readable.
    await fsp.mkdir(uploadDir, { recursive: true, mode: 0o755 });
    await fsp.chmod(uploadDir, 0o755).catch(() => {});
    photos = ((await readJson(metaFile, { photos: [] })).photos || []).filter((p) => p && ID.test(p.id));
  }

  const save = () => writeJson(metaFile, { version: 1, photos });
  const publicPhoto = (p) => ({
    id: p.id, alt: p.alt, width: p.width, height: p.height, widths: p.widths, bytes: p.bytes,
    createdAt: p.createdAt, createdBy: p.createdBy, updatedAt: p.updatedAt || null,
    thumb: `/uploads/${variantFile(p.id, p.widths[0])}`,
  });

  function cleanAlt(value) {
    // Remove control characters first, then collapse and trim, so invisible input becomes empty.
    const text = String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (text.length > limits.maxAlt) throw new PhotoError(`The description can be at most ${limits.maxAlt} characters.`);
    return text;
  }

  async function add(buffer, { alt = '', by = null } = {}) {
    return exclusive(async () => {
      if (photos.length >= limits.maxPhotos) throw new PhotoError(`The library is full (${limits.maxPhotos} photos). Delete some unused photos first.`, 409);
      const description = cleanAlt(alt);
      const result = await processImage(buffer, limits);
      const id = newId();
      const written = [];
      try {
        for (const v of result.variants) {
          const file = path.join(uploadDir, variantFile(id, v.width));
          await writeFileAtomic(file, v.data, 0o644);
          written.push(file);
        }
        const file = path.join(uploadDir, shareFile(id));
        await writeFileAtomic(file, result.share, 0o644);
        written.push(file);
        const photo = {
          id, alt: description, width: result.width, height: result.height,
          widths: result.variants.map((v) => v.width),
          bytes: result.variants.reduce((sum, v) => sum + v.data.length, result.share.length),
          createdAt: new Date(now()).toISOString(), createdBy: by,
        };
        photos.push(photo);
        await save();
        return publicPhoto(photo);
      } catch (err) {
        for (const file of written) await fsp.rm(file, { force: true });
        photos = photos.filter((p) => p.id !== id);
        throw err;
      }
    });
  }

  async function update(id, { alt }, by, { requireText = false } = {}) {
    return exclusive(async () => {
      const photo = photos.find((p) => p.id === id);
      if (!photo) throw new PhotoError('That photo no longer exists.', 404);
      const description = cleanAlt(alt);
      // Checked on the cleaned text, so whitespace or invisible characters don't count as a description.
      if (requireText && !description) throw new PhotoError('This photo is used on the website, so it needs a description.');
      photo.alt = description;
      photo.updatedAt = new Date(now()).toISOString();
      photo.updatedBy = by;
      await save();
      return publicPhoto(photo);
    });
  }

  // isInUse(id) is checked inside the queue, so a photo can't be deleted while it is being put on the page.
  async function remove(id, isInUse) {
    return exclusive(async () => {
      const photo = photos.find((p) => p.id === id);
      if (!photo) throw new PhotoError('That photo no longer exists.', 404);
      const usage = isInUse ? isInUse(id) : [];
      if (usage.length) throw new PhotoError(`This photo is still used on the website (${usage.join(', ')}). Remove it there first.`, 409);
      photos = photos.filter((p) => p.id !== id);
      await save();
      for (const width of photo.widths) await fsp.rm(path.join(uploadDir, variantFile(id, width)), { force: true });
      await fsp.rm(path.join(uploadDir, shareFile(id)), { force: true });
      return publicPhoto(photo);
    });
  }

  function lookup() {
    return new Map(photos.map((p) => [p.id, { id: p.id, alt: p.alt, width: p.width, height: p.height, widths: p.widths }]));
  }

  return {
    load, add, update, remove, lookup,
    list: () => photos.map(publicPhoto).reverse(),
    has: (id) => photos.some((p) => p.id === id),
    get: (id) => {
      const p = photos.find((x) => x.id === id);
      return p ? publicPhoto(p) : null;
    },
    exclusive,
  };
}

module.exports = { createMediaStore, processImage, PhotoError, LIMITS, WIDTHS, ID_PATTERN: ID, variantFile, shareFile };
