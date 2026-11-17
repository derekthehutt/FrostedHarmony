'use strict';

// Editable page content: defaults (identical to the original hand-written page), validation and
// the draft / publish / history store.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { readJson, writeJson, writeFileAtomic, ensurePrivateDir } = require('./store');
const { randomToken } = require('./crypto');

const SECTION_IDS = ['gallery', 'flavors', 'ordering'];
const HISTORY_KEEP = 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_CONTENT = Object.freeze({
  seo: {
    title: 'Frosted Harmony | Handcrafted Cupcakes',
    description: 'Frosted Harmony bakes handcrafted cupcakes for birthdays, weddings, showers and every sweet moment in between. Request pricing or a custom order.',
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
  },
  gallery: {
    visible: true, navLabel: 'Gallery', eyebrow: 'Fresh from the oven', heading: 'Our latest creations',
    intro: 'A peek at what we have been baking lately, straight from our Instagram.', followButton: 'Follow us on Instagram',
  },
  flavors: {
    visible: true, navLabel: 'Flavors', eyebrow: 'Something for everyone', heading: 'Signature flavors',
    intro: 'Ask about seasonal specials and custom flavor combinations.',
    items: [
      { name: 'Classic Vanilla Bean', description: 'Fluffy vanilla bean cake topped with silky vanilla buttercream.', price: '' },
      { name: 'Double Chocolate', description: 'Rich chocolate cake with chocolate ganache buttercream.', price: '' },
      { name: 'Strawberry Shortcake', description: 'Strawberry cake, fresh strawberry filling and whipped cream frosting.', price: '' },
      { name: 'Salted Caramel', description: 'Brown sugar cake with caramel filling and a pinch of sea salt.', price: '' },
      { name: 'Lemon Raspberry', description: 'Bright lemon cake with raspberry buttercream.', price: '' },
      { name: 'Red Velvet', description: 'Classic red velvet with tangy cream cheese frosting.', price: '' },
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
  text = multiline ? text.split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim() : text.replace(/\s+/g, ' ').trim();
  // Control characters other than newline are never valid in page text.
  text = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '');
  if (required && !text) errors.push(`${label} can't be empty.`);
  if (text.length > max) errors.push(`${label} is too long (${text.length} characters; the limit is ${max}).`);
  return text;
}

// Returns { content, errors }. The result always has every field, so the renderer never sees gaps.
function normalizeContent(raw) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};
  const content = clone(DEFAULT_CONTENT);

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
  }));

  const steps = listOrDefault('ordering.steps');
  if (steps.length > 10) errors.push('There can be at most 10 ordering steps.');
  content.ordering.steps = steps.slice(0, 10).map((step, i) => ({
    title: cleanText(step && step.title, `Ordering step ${i + 1}: title`, 80, true, false, errors),
    text: cleanText(step && step.text, `Ordering step ${i + 1}: text`, 400, false, true, errors),
  }));

  return { content, errors };
}

function createContentStore({ dir, siteDir, render, now = () => Date.now() }) {
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
    // Re-normalize in case defaults or rules changed in a newer version of the site.
    draft.content = normalizeContent(draft.content).content;
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
    const { content, errors } = normalizeContent(rawContent);
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
    await writeFileAtomic(pageFile, render(content), 0o644);
  }

  async function publishContent(raw, actor) {
    const { content, errors } = normalizeContent(raw);
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
      if (entry) entries.push({ id: entry.id, at: entry.at, by: entry.by, label: entry.label, live: Boolean(published) && sameContent(entry.content, published.content) });
    }
    return entries;
  }

  // publish=false copies an old version into the draft (for editing). publish=true puts it live
  // directly and leaves the shared draft untouched, so nobody's unpublished work is lost.
  async function restore(id, { publish: andPublish = false, revision } = {}, actor) {
    if (typeof id !== 'string' || !/^[0-9]+-[A-Za-z0-9]+$/.test(id)) return { ok: false, status: 400, error: 'Unknown version.' };
    const entry = await readJson(path.join(historyDir, `${id}.json`), null);
    if (!entry) return { ok: false, status: 404, error: 'That version no longer exists.' };
    if (andPublish) return publishContent(entry.content, actor);
    if (revision !== draft.revision) {
      return { ok: false, status: 409, error: 'Someone else saved the draft since you opened this page. Reload before replacing it.' };
    }
    const { content } = normalizeContent(entry.content);
    const next = { revision: draft.revision + 1, content, savedAt: new Date(now()).toISOString(), savedBy: actor };
    await writeJson(draftFile, next);
    draft = next;
    return { ok: true };
  }

  // After an upgrade, regenerate the live page so template improvements reach published content.
  async function regenerate() {
    if (published) await writePage(normalizeContent(published.content).content);
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
    preview: () => draft.content,
    pageFile,
  };
}

module.exports = { DEFAULT_CONTENT, SECTION_IDS, normalizeContent, createContentStore };
