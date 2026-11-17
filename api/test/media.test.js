'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { processImage, createMediaStore, LIMITS } = require('../lib/media');

const solid = (width, height, format = 'jpeg') => sharp({ create: { width, height, channels: 3, background: '#d94f6b' } })[format]().toBuffer();

// A phone-style photo: stored sideways (EXIF orientation 6) with GPS coordinates and camera details.
const phonePhoto = () => sharp({ create: { width: 900, height: 600, channels: 3, background: '#d94f6b' } })
  .withExif({ IFD0: { Make: 'TestPhone', Model: 'X1' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '47/1 36/1 22/1', GPSLongitudeRef: 'W', GPSLongitude: '122/1 19/1 59/1' } })
  .withMetadata({ orientation: 6 })
  .jpeg().toBuffer();

function storeIn(limits) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-media-'));
  const store = createMediaStore({ metaFile: path.join(root, 'admin', 'media.json'), uploadDir: path.join(root, 'uploads'), limits });
  fs.mkdirSync(path.join(root, 'admin'));
  return { root, store };
}

test('phone photos are turned upright and lose ALL metadata, including GPS location', async () => {
  const input = await phonePhoto();
  const before = await sharp(input).metadata();
  assert.equal(before.orientation, 6);
  assert.ok(before.exif.includes(Buffer.from([0x25, 0x88])), 'fixture should contain a GPS tag');

  const out = await processImage(input);
  assert.equal(out.width, 600, 'width and height are swapped for a sideways photo');
  assert.equal(out.height, 900);
  for (const data of [...out.variants.map((v) => v.data), out.share]) {
    const meta = await sharp(data).metadata();
    assert.equal(meta.exif, undefined);
    assert.equal(meta.xmp, undefined);
    assert.equal(meta.iptc, undefined);
    assert.equal(meta.orientation, undefined);
    assert.ok(!data.includes(Buffer.from('TestPhone')));
  }
  const biggest = await sharp(out.variants[out.variants.length - 1].data).metadata();
  assert.deepEqual([biggest.width, biggest.height, biggest.format], [600, 900, 'webp']);
  const share = await sharp(out.share).metadata();
  assert.deepEqual([share.width, share.height, share.format], [1200, 630, 'jpeg']);
});

test('sizes are 400/800/1600 wide, never enlarged', async () => {
  assert.deepEqual((await processImage(await solid(4000, 3000))).variants.map((v) => v.width), [400, 800, 1600]);
  assert.deepEqual((await processImage(await solid(1000, 700, 'png'))).variants.map((v) => v.width), [400, 800, 1000]);
  assert.deepEqual((await processImage(await solid(300, 300, 'webp'))).variants.map((v) => v.width), [300]);
});

test('anything that is not a usable still photo is rejected with a clear message', async () => {
  const cases = [
    [Buffer.from('definitely not an image'), /JPEG, PNG or WebP/],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><script>alert(1)</script></svg>'), /JPEG, PNG or WebP/],
    [await solid(400, 400, 'gif'), /JPEG, PNG or WebP/],
    [await solid(400, 400, 'tiff'), /JPEG, PNG or WebP/],
    [await solid(100, 900), /too small/],
    [Buffer.alloc(0), /empty/],
  ];
  for (const [buffer, message] of cases) await assert.rejects(processImage(buffer), message);
  // A real JPEG cut short (for example a broken upload) must fail cleanly, not crash.
  const truncated = (await solid(1200, 900)).subarray(0, 2000);
  await assert.rejects(processImage(truncated), (err) => err.status === 400);
});

test('size and pixel limits are enforced before decoding', async () => {
  await assert.rejects(processImage(await solid(2000, 1500), { ...LIMITS, maxPixels: 1_000_000 }), /too many pixels/);
  await assert.rejects(processImage(await solid(800, 800), { ...LIMITS, maxBytes: 1000 }), (err) => err.status === 413);
});

test('the store saves resized files for the web and private metadata separately', async () => {
  const { root, store } = storeIn();
  await store.load();
  const photo = await store.add(await phonePhoto(), { alt: '  Red velvet\ncupcakes  ', by: 'derek' });
  assert.match(photo.id, /^[A-Za-z0-9]{16}$/);
  assert.equal(photo.alt, 'Red velvet cupcakes');
  assert.deepEqual(photo.widths, [400, 600]);
  const files = fs.readdirSync(path.join(root, 'uploads')).sort();
  assert.deepEqual(files, [`${photo.id}-400.webp`, `${photo.id}-600.webp`, `${photo.id}-share.jpg`].sort());
  if (process.platform !== 'win32') {
    for (const file of files) assert.equal(fs.statSync(path.join(root, 'uploads', file)).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(root, 'admin', 'media.json')).mode & 0o077, 0);
  }

  const again = createMediaStore({ metaFile: path.join(root, 'admin', 'media.json'), uploadDir: path.join(root, 'uploads') });
  await again.load();
  assert.equal(again.list()[0].alt, 'Red velvet cupcakes');

  const updated = await store.update(photo.id, { alt: 'Pink cupcakes' }, 'wife');
  assert.equal(updated.alt, 'Pink cupcakes');
  await assert.rejects(store.update(photo.id, { alt: ' \u0001 \u0002 ' }, 'wife', { requireText: true }), /needs a description/);
  assert.equal(store.get(photo.id).alt, 'Pink cupcakes', 'a refused change leaves the old description');
  assert.equal((await store.update(photo.id, { alt: '' }, 'wife')).alt, '', 'unused photos may have no description');
  await assert.rejects(store.update(photo.id, { alt: 'x'.repeat(251) }, 'wife'), /at most 250/);
  await assert.rejects(store.update('AAAAAAAAAAAAAAAA', { alt: 'x' }, 'wife'), (err) => err.status === 404);
});

test('a photo in use cannot be deleted; an unused one is removed with its files', async () => {
  const { root, store } = storeIn();
  await store.load();
  const photo = await store.add(await solid(500, 500));
  await assert.rejects(store.remove(photo.id, () => ['Gallery']), (err) => err.status === 409 && /Gallery/.test(err.message));
  assert.equal(store.has(photo.id), true);
  await store.remove(photo.id, () => []);
  assert.equal(store.has(photo.id), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'uploads')), []);
});

test('the library has a size limit and failed uploads leave nothing behind', async () => {
  const { root, store } = storeIn({ ...LIMITS, maxPhotos: 1 });
  await store.load();
  await store.add(await solid(500, 500));
  await assert.rejects(store.add(await solid(500, 500)), (err) => err.status === 409);
  await assert.rejects(store.add(Buffer.from('nope')));
  assert.equal(store.list().length, 1);
  assert.equal(fs.readdirSync(path.join(root, 'uploads')).length, 3);
});
