'use strict';

// Editable page content: defaults (identical to the original hand-written page), validation and
// the draft / publish / history store.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { readJson, writeJson, writeFileAtomic, ensurePrivateDir } = require('./store');
const { randomToken } = require('./crypto');

const SECTION_IDS = ['gallery', 'flavors', 'ordering'];
const GALLERY_SOURCES = ['mixed', 'photos', 'instagram'];
const PHOTO_ID = /^[A-Za-z0-9]{16}$/;
const MAX_GALLERY_PHOTOS = 60;
const HISTORY_KEEP = 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_CONTENT = Object.freeze({
  seo: {
    title: 'Frosted Harmony | Handcrafted Cupcakes',
    description: 'Frosted Harmony bakes handcrafted cupcakes for birthdays, weddings, showers and every sweet moment in between. Request pricing or a custom order.',
    siteUrl: 'https://frostedharmony.com',
    shareImage: '',
  },
  brand: { name: 'Frosted Harmony', tagline: 'Baked with love.' },
  links: { instagramUrl: 'https://www.instagram.com/frostedharmony/', email: 'cupcakes@frostedharmony.com' },
  order: ['gallery', 'flavors', 'ordering'],
  hero: {
    eyebrow: 'Handcrafted cupcakes, baked to order',
    heading: 'Sweet moments, frosted to perfection.',
    lead: 'From birthday parties to wedding dessert tables, every Frosted Harmony cupcake is baked from scratch and decorated by hand to make your celebration unforgettable.',
    primaryButton: 'Request pricing',
    secondaryButton: 'See our cupcakes',
    image: '',
  },
  gallery: {
    visible: true, navLabel: 'Gallery', eyebrow: 'Fresh from the oven', heading: 'Our latest creations',
    intro: 'A peek at what we have been baking lately, straight from our Instagram.', followButton: 'Follow us on Instagram',
    source: 'mixed', photos: [],
  },
  flavors: {
    visible: true, navLabel: 'Flavors', eyebrow: 'Something for everyone', heading: 'Signature flavors',
    intro: 'Ask about seasonal specials and custom flavor combinations.',
    items: [
      { name: 'Classic Vanilla Bean', description: 'Fluffy vanilla bean cake topped with silky vanilla buttercream.', price: '', image: '' },
      { name: 'Double Chocolate', description: 'Rich chocolate cake with chocolate ganache buttercream.', price: '', image: '' },
      { name: 'Strawberry Shortcake', description: 'Strawberry cake, fresh strawberry filling and whipped cream frosting.', price: '', image: '' },
      { name: 'Salted Caramel', description: 'Brown sugar cake with caramel filling and a pinch of sea salt.', price: '', image: '' },
      { name: 'Lemon Raspberry', description: 'Bright lemon cake with raspberry buttercream.', price: '', image: '' },
      { name: 'Red Velvet', description: 'Classic red velvet with tangy cream cheese frosting.', price: '', image: '' },
    ],
  },
  ordering: {
    visible: true, navLabel: 'Ordering', eyebrow: 'Simple and sweet', heading: 'How ordering works', intro: '',
    steps: [
      { title: 'Send an inquiry', text: 'Tell us your date, how many cupcakes you need and any theme or flavor ideas.' },
      { title: 'Get a quote', text: 'We will reply with pricing and options, usually within one to two days.' },
      { title: 'Enjoy!', text: 'Once confirmed, we bake and decorate your cupcakes fresh for pickup.' },
    ],
  },
  contact: {
    navLabel: 'Inquire', eyebrow: "Let's talk cupcakes", heading: 'Request pricing or ask a question',
    intro: 'Fill out the form and we will get back to you by email. For custom orders, please reach out at least one to two weeks before your event.',
    emailPrompt: 'Prefer email? Write to',
  },
});

const clone = (value) => JSON.parse(JSON.stringify(value));

// Field rules: [path, label, max length, required]. Text may contain line breaks only where multiline is set.
const TEXT_FIELDS = [
  ['seo.title', 'Browser tab title', 70, true], ['seo.description', 'Search engine description', 300, true],
  ['brand.name', 'Business name', 60, true], ['brand.tagline', 'Footer tagline', 120, false],
  ['hero.eyebrow', 'Top banner: small heading', 120], ['hero.heading', 'Top banner: main heading', 120, true],
  ['hero.lead', 'Top banner: text', 600, false, true], ['hero.primaryButton', 'Top banner: main button', 40, true],
  ['hero.secondaryButton', 'Top banner: second button', 40],
  ['gallery.navLabel', 'Gallery: menu label', 30, true], ['gallery.eyebrow', 'Gallery: small heading', 120],
  ['gallery.heading', 'Gallery: heading', 120, true], ['gallery.intro', 'Gallery: text', 600, false, true],
  ['gallery.followButton', 'Gallery: Instagram button', 40],
  ['flavors.navLabel', 'Flavors: menu label', 30, true], ['flavors.eyebrow', 'Flavors: small heading', 120],
  ['flavors.heading', 'Flavors: heading', 120, true], ['flavors.intro', 'Flavors: text', 600, false, true],
  ['ordering.navLabel', 'Ordering: menu label', 30, true], ['ordering.eyebrow', 'Ordering: small heading', 120],
  ['ordering.heading', 'Ordering: heading', 120, true], ['ordering.intro', 'Ordering: text', 600, false, true],
  ['contact.navLabel', 'Contact: menu button', 30, true], ['contact.eyebrow', 'Contact: small heading', 120],
  ['contact.heading', 'Contact: heading', 120, true], ['contact.intro', 'Contact: text', 800, false, true],
  ['contact.emailPrompt', 'Contact: text before the email address', 120],
];

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, key) => (o && typeof o === 'object' ? o[key] : undefined), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let target = obj;
  for (const key of keys.slice(0, -1)) target = target[key];
  target[keys[keys.length - 1]] = value;
}

function cleanText(value, label, max, required, multiline, errors) {
  let text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  text = text.replace(/\r\n?/g, '\n');
  // Control characters other than newline are never valid in page text. They are removed before
  // trimming, so text made only of invisible characters counts as empty.
  text = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  text = multiline ? text.split('\n').map((line) => line.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim() : text.replace(/\s+/g, ' ').trim();
  if (required && !text) errors.push(`${label} can't be empty.`);
  if (text.length > max) errors.push(`${label} is too long (${text.length} characters; the limit is ${max}).`);
  return text;
}

// Returns { content, errors }. The result always has every field, so the renderer never sees gaps.
// options.photos: Map of existing photo ids. options.missingPhotos: 'error' (saving) or 'drop'
// (loading old versions whose photo was deleted since).
function normalizeContent(raw, { photos = null, missingPhotos = 'error' } = {}) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};
  const content = clone(DEFAULT_CONTENT);

  const photoRef = (value, label) => {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || !PHOTO_ID.test(value)) {
      errors.push(`${label}: invalid photo.`);
      return '';
    }
    if (photos && !photos.has(value)) {
      if (missingPhotos === 'error') errors.push(`${label}: that photo was deleted. Choose another one.`);
      return '';
    }
    return value;
  };

  for (const [field, label, max, required = false, multiline = false] of TEXT_FIELDS) {
    const value = getPath(input, field);
    // A field missing entirely (for example added in a newer version) keeps its default.
    setPath(content, field, cleanText(value === undefined ? getPath(DEFAULT_CONTENT, field) : value, label, max, required, multiline, errors));
  }

  for (const id of SECTION_IDS) {
    const section = input[id];
    content[id].visible = !(section && section.visible === false);
  }

  const order = Array.isArray(input.order) ? input.order.filter((id) => SECTION_IDS.includes(id)) : [];
  content.order = [...new Set(order)];
  for (const id of SECTION_IDS) if (!content.order.includes(id)) content.order.push(id);

  const links = input.links || {};
  const linkValue = (key) => (links[key] === undefined ? DEFAULT_CONTENT.links[key] : links[key]);
  content.links.instagramUrl = cleanText(linkValue('instagramUrl'), 'Instagram link', 200, false, false, errors);
  if (content.links.instagramUrl) {
    let ok = false;
    try {
      const url = new URL(content.links.instagramUrl);
      ok = url.protocol === 'https:' && /(^|\.)instagram\.com$/i.test(url.hostname);
    } catch {
      ok = false;
    }
    if (!ok) errors.push('Instagram link must be an https://www.instagram.com/... address.');
  }
  content.links.email = cleanText(linkValue('email'), 'Contact email', 200, true, false, errors);
  if (content.links.email && !EMAIL.test(content.links.email)) errors.push('Contact email must be an email address.');

  const seo = input.seo || {};
  content.seo.siteUrl = cleanText(seo.siteUrl === undefined ? DEFAULT_CONTENT.seo.siteUrl : seo.siteUrl, 'Website address', 200, true, false, errors);
  try {
    const url = new URL(content.seo.siteUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username) throw new Error('bad');
    content.seo.siteUrl = url.origin;
  } catch {
    if (content.seo.siteUrl) errors.push('Website address must look like https://frostedharmony.com');
  }
  content.seo.shareImage = photoRef(seo.shareImage, 'Link preview photo');
  content.hero.image = photoRef((input.hero || {}).image, 'Top banner photo');

  const gallery = input.gallery || {};
  content.gallery.source = GALLERY_SOURCES.includes(gallery.source) ? gallery.source : DEFAULT_CONTENT.gallery.source;
  const galleryPhotos = gallery.photos === undefined ? [] : gallery.photos;
  if (!Array.isArray(galleryPhotos)) errors.push('Invalid gallery photo list.');
  else {
    if (galleryPhotos.length > MAX_GALLERY_PHOTOS) errors.push(`The gallery can have at most ${MAX_GALLERY_PHOTOS} photos.`);
    const ids = galleryPhotos.slice(0, MAX_GALLERY_PHOTOS).map((id, i) => photoRef(id, `Gallery photo ${i + 1}`)).filter(Boolean);
    content.gallery.photos = [...new Set(ids)];
  }

  const listOrDefault = (dotted) => {
    const value = getPath(input, dotted);
    if (value === undefined) return clone(getPath(DEFAULT_CONTENT, dotted));
    if (!Array.isArray(value)) {
      errors.push('Invalid list in the content.');
      return [];
    }
    return value;
  };

  const flavors = listOrDefault('flavors.items');
  if (flavors.length > 40) errors.push('There can be at most 40 flavors.');
  content.flavors.items = flavors.slice(0, 40).map((item, i) => ({
    name: cleanText(item && item.name, `Flavor ${i + 1}: name`, 80, true, false, errors),
    description: cleanText(item && item.description, `Flavor ${i + 1}: description`, 400, false, true, errors),
    price: cleanText(item && item.price, `Flavor ${i + 1}: price`, 40, false, false, errors),
    image: photoRef(item && item.image, `Flavor ${i + 1}: photo`),
  }));

  const steps = listOrDefault('ordering.steps');
  if (steps.length > 10) errors.push('There can be at most 10 ordering steps.');
  content.ordering.steps = steps.slice(0, 10).map((step, i) => ({
    title: cleanText(step && step.title, `Ordering step ${i + 1}: title`, 80, true, false, errors),
    text: cleanText(step && step.text, `Ordering step ${i + 1}: text`, 400, false, true, errors),
  }));

  return { content, errors };
}

// Where each photo appears in a piece of content, as readable labels ("Gallery", "Flavor: Red Velvet").
function photoUsage(content) {
  const usage = new Map();
  const add = (id, label) => {
    if (!id) return;
    if (!usage.has(id)) usage.set(id, []);
    if (!usage.get(id).includes(label)) usage.get(id).push(label);
  };
  if (!content) return usage;
  add(content.seo && content.seo.shareImage, 'Link preview');
  add(content.hero && content.hero.image, 'Top banner');
  for (const id of (content.gallery && content.gallery.photos) || []) add(id, 'Gallery');
  for (const item of (content.flavors && content.flavors.items) || []) add(item.image, `Flavor: ${item.name || 'unnamed'}`);
  return usage;
}

function createContentStore({ dir, siteDir, render, photos = () => null, now = () => Date.now() }) {
  const historyDir = path.join(dir, 'history');
  const draftFile = path.join(dir, 'draft.json');
  const publishedFile = path.join(dir, 'published.json');
  const pageFile = path.join(siteDir, 'index.html');
  let draft;
  let published;
  // Content changes run one at a time, so two admins saving at once can't both pass the revision check.
  let queue = Promise.resolve();
  const exclusive = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  async function load() {
    await ensurePrivateDir(dir);
    await ensurePrivateDir(historyDir);
    // nginx (a different user) must be able to read the generated page.
    await fsp.mkdir(siteDir, { recursive: true, mode: 0o755 });
    await fsp.chmod(siteDir, 0o755).catch(() => {});
    published = await readJson(publishedFile, null);
    draft = await readJson(draftFile, null);
    if (!draft) draft = { revision: 0, content: clone(published ? published.content : DEFAULT_CONTENT), savedAt: null, savedBy: null };
    // Re-normalize in case defaults or rules changed in a newer version of the site (for example new
    // fields), so an upgrade alone never shows up as "unpublished changes".
    const tidy = (c) => normalizeContent(c, { photos: photos(), missingPhotos: 'drop' }).content;
    draft.content = tidy(draft.content);
    if (published) published.content = tidy(published.content);
  }

  const sameContent = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const liveContent = () => (published ? published.content : DEFAULT_CONTENT);

  function state() {
    return {
      draft: draft.content,
      revision: draft.revision,
      savedAt: draft.savedAt,
      savedBy: draft.savedBy,
      published: published ? { at: published.at, by: published.by } : null,
      hasUnpublishedChanges: !sameContent(draft.content, liveContent()),
    };
  }

  async function saveDraft(rawContent, revision, actor) {
    if (revision !== draft.revision) {
      return { ok: false, status: 409, error: 'Someone else saved changes since you opened this page. Reload to see them before saving.' };
    }
    const { content, errors } = normalizeContent(rawContent, { photos: photos() });
    if (errors.length) return { ok: false, status: 400, error: errors.join(' ') };
    const next = { revision: draft.revision + 1, content, savedAt: new Date(now()).toISOString(), savedBy: actor };
    await writeJson(draftFile, next);
    draft = next;
    return { ok: true };
  }

  async function addHistory(content, by, label) {
    const at = new Date(now()).toISOString();
    const id = `${now()}-${randomToken(4).replace(/[^A-Za-z0-9]/g, '')}`;
    await writeJson(path.join(historyDir, `${id}.json`), { id, at, by, label, content });
    const files = (await fsp.readdir(historyDir)).filter((f) => f.endsWith('.json')).sort();
    // Keep the newest entries; the original site (label "original") is never deleted.
    const removable = [];
    for (const file of files) {
      const entry = await readJson(path.join(historyDir, file), null);
      if (!entry || entry.label !== 'original') removable.push(file);
    }
    for (const file of removable.slice(0, Math.max(0, removable.length - HISTORY_KEEP))) {
      await fsp.rm(path.join(historyDir, file), { force: true });
    }
  }

  async function writePage(content) {
    await writeFileAtomic(pageFile, render(content, { photos: photos() }), 0o644);
  }

  // Every photo on the live site needs a description (for screen readers and search engines).
  function missingDescriptions(content) {
    const library = photos();
    if (!library) return [];
    const problems = [];
    for (const [id, labels] of photoUsage(content)) {
      const photo = library.get(id);
      if (photo && !photo.alt) problems.push(`The photo used in ${labels.join(', ')} needs a description. Add one on the Photos tab.`);
    }
    return problems;
  }

  // missingPhotos 'drop' is for old versions: photos deleted since are left out instead of failing.
  async function publishContent(raw, actor, { missingPhotos = 'error' } = {}) {
    const { content, errors } = normalizeContent(raw, { photos: photos(), missingPhotos });
    errors.push(...missingDescriptions(content));
    if (errors.length) return { ok: false, status: 400, error: errors.join(' ') };
    if (!published) await addHistory(clone(DEFAULT_CONTENT), null, 'original');
    await writePage(content);
    const next = { content, at: new Date(now()).toISOString(), by: actor };
    await writeJson(publishedFile, next);
    published = next;
    await addHistory(content, actor, 'published');
    return { ok: true };
  }

  // Publishes the draft, but only if it is still the revision the admin previewed. The check runs
  // inside the queue, so a save that lands just before can't slip unseen changes onto the site.
  async function publish(actor, revision) {
    if (revision !== draft.revision) {
      return { ok: false, status: 409, error: 'The draft changed since you loaded it. Reload, check the preview, then publish.' };
    }
    return publishContent(draft.content, actor);
  }

  async function discard(actor) {
    const next = { revision: draft.revision + 1, content: clone(liveContent()), savedAt: new Date(now()).toISOString(), savedBy: actor };
    await writeJson(draftFile, next);
    draft = next;
  }

  async function history() {
    let files = [];
    try {
      files = (await fsp.readdir(historyDir)).filter((f) => f.endsWith('.json')).sort().reverse();
    } catch {
      return [];
    }
    const entries = [];
    for (const file of files) {
      const entry = await readJson(path.join(historyDir, file), null);
      if (!entry) continue;
      const live = Boolean(published) && sameContent(normalizeContent(entry.content, { photos: photos(), missingPhotos: 'drop' }).content, published.content);
      entries.push({ id: entry.id, at: entry.at, by: entry.by, label: entry.label, live });
    }
    return entries;
  }

  // publish=false copies an old version into the draft (for editing). publish=true puts it live
  // directly and leaves the shared draft untouched, so nobody's unpublished work is lost.
  async function restore(id, { publish: andPublish = false, revision } = {}, actor) {
    if (typeof id !== 'string' || !/^[0-9]+-[A-Za-z0-9]+$/.test(id)) return { ok: false, status: 400, error: 'Unknown version.' };
    const entry = await readJson(path.join(historyDir, `${id}.json`), null);
    if (!entry) return { ok: false, status: 404, error: 'That version no longer exists.' };
    if (andPublish) return publishContent(entry.content, actor, { missingPhotos: 'drop' });
    if (revision !== draft.revision) {
      return { ok: false, status: 409, error: 'Someone else saved the draft since you opened this page. Reload before replacing it.' };
    }
    const { content } = normalizeContent(entry.content, { photos: photos(), missingPhotos: 'drop' });
    const next = { revision: draft.revision + 1, content, savedAt: new Date(now()).toISOString(), savedBy: actor };
    await writeJson(draftFile, next);
    draft = next;
    return { ok: true };
  }

  // After an upgrade, regenerate the live page so template improvements reach published content.
  async function regenerate() {
    if (published) await writePage(normalizeContent(published.content, { photos: photos(), missingPhotos: 'drop' }).content);
  }

  // Labels for where a photo is used in the draft or on the live site (empty when unused).
  function usage(id) {
    const labels = new Set();
    for (const content of [draft.content, liveContent()]) {
      for (const label of photoUsage(content).get(id) || []) labels.add(label);
    }
    return [...labels];
  }

  return {
    load,
    state,
    saveDraft: (raw, revision, actor) => exclusive(() => saveDraft(raw, revision, actor)),
    publish: (actor, revision) => exclusive(() => publish(actor, revision)),
    discard: (actor) => exclusive(() => discard(actor)),
    restore: (id, options, actor) => exclusive(() => restore(id, options, actor)),
    history,
    regenerate,
    usage,
    exclusive,
    preview: () => draft.content,
    pageFile,
  };
}

module.exports = { DEFAULT_CONTENT, SECTION_IDS, GALLERY_SOURCES, normalizeContent, photoUsage, createContentStore };
