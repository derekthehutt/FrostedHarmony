'use strict';

// Editable website content: pages made of blocks, the site-wide header/footer details and menu,
// validation, and the draft / publish / history store.
//
// Content saved before pages existed (one fixed home page, "version 1") is converted on the fly,
// so old drafts, published versions and backups keep working. The default content is that original
// page, and it renders exactly the hand-written site/index.html.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { readJson, writeJson, writeFileAtomic, ensurePrivateDir } = require('./store');
const { randomToken } = require('./crypto');
const { normalizeTheme } = require('./theme');

const PHOTO_ID = /^[A-Za-z0-9]{16}$/;
const ITEM_ID = /^[a-z0-9]{1,16}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ANCHOR = /^[a-z][a-z0-9-]{0,39}$/;
const TARGET = /^(?:page:[a-z0-9]{1,16}|block:[a-z0-9]{1,16}:[a-z0-9]{1,16}|instagram|email)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PAGES = 20;
const MAX_BLOCKS = 30;
const MAX_MENU = 12;
const MAX_GALLERY_PHOTOS = 60;
const HISTORY_KEEP = 30;
// Page addresses that belong to the website itself (folders, files, Cloudflare and the portal).
const RESERVED_SLUGS = [
  'admin', 'api', 'uploads', 'ig', 'site-assets', 'fonts', 'images', 'index', 'styles', 'script', 'gallery',
  'theme-mode', 'favicon', 'robots', 'sitemap', 'home', 'pages', 'preview', 'assets', 'static', 'cdn-cgi', 'well-known',
];
// Element ids the page itself uses; a block's link name can't take them.
const RESERVED_ANCHORS = ['top', 'site-nav', 'gallery-grid', 'inquiry-form', 'form-status', 'year', 'name', 'email', 'phone', 'quantity', 'message'];

// ---------- Block types ----------
// One description drives validation here and the editor in the admin portal (sent with the content).

const text = (key, label, max, extra = {}) => ({ key, kind: 'text', label, max, ...extra });
const area = (key, label, max, extra = {}) => ({ key, kind: 'textarea', label, max, ...extra });
const photo = (key, label, help) => ({ key, kind: 'photo', label, help });
const button = (key, label, help) => ({ key, kind: 'button', label, help });
const choice = (key, label, options) => ({ key, kind: 'choice', label, options });

const HEADING_FIELDS = [text('eyebrow', 'Small heading', 120)];

const BLOCK_TYPES = {
  hero: {
    label: 'Top banner',
    description: 'A big heading with text, up to two buttons and a photo (or the cupcake drawing). Usually the first block on a page.',
    anchor: 'optional', background: false,
    fields: [
      ...HEADING_FIELDS, text('heading', 'Main heading', 120, { required: true }), area('lead', 'Text', 600),
      photo('image', 'Photo (optional)', 'Leave empty to show the cupcake drawing.'),
      button('primaryButton', 'Main button'), button('secondaryButton', 'Second button'),
    ],
    defaults: { eyebrow: '', heading: 'A new heading', lead: '', image: '', primaryButton: { label: '', target: '' }, secondaryButton: { label: '', target: '' } },
  },
  text: {
    label: 'Text',
    description: 'A heading with one or more paragraphs, and an optional button. For an "About us" story, policies or news.',
    fields: [...HEADING_FIELDS, text('heading', 'Heading', 120), area('body', 'Text', 3000, { help: 'Leave an empty line between paragraphs.' }), button('button', 'Button')],
    defaults: { eyebrow: '', heading: 'New section', body: 'Write something here.', button: { label: '', target: '' } },
  },
  imageText: {
    label: 'Photo and text',
    description: 'A photo beside a heading and text, with an optional button.',
    fields: [
      ...HEADING_FIELDS, text('heading', 'Heading', 120), area('body', 'Text', 2000, { help: 'Leave an empty line between paragraphs.' }),
      photo('image', 'Photo'), choice('imageSide', 'Photo position', [['right', 'Photo on the right'], ['left', 'Photo on the left']]),
      button('button', 'Button'),
    ],
    defaults: { eyebrow: '', heading: 'New section', body: '', image: '', imageSide: 'right', button: { label: '', target: '' } },
  },
  gallery: {
    label: 'Gallery',
    description: 'A grid of your photos and/or the latest Instagram posts. One per page.',
    single: true,
    fields: [
      ...HEADING_FIELDS, text('heading', 'Heading', 120, { required: true }), area('intro', 'Text', 600),
      choice('source', 'What the gallery shows', [['mixed', 'My photos first, then the latest Instagram posts'], ['photos', 'Only my photos'], ['instagram', 'Only Instagram posts']]),
      { key: 'photos', kind: 'photos', label: 'My gallery photos', max: MAX_GALLERY_PHOTOS },
      text('followButton', 'Instagram button', 40, { help: 'Leave empty to hide it.' }),
    ],
    defaults: { eyebrow: '', heading: 'Gallery', intro: '', source: 'photos', photos: [], followButton: '' },
  },
  cards: {
    label: 'Flavor cards',
    description: 'Cards with a name, description, optional price and photo. For flavors, packages or products.',
    fields: [
      ...HEADING_FIELDS, text('heading', 'Heading', 120, { required: true }), area('intro', 'Text', 600),
      {
        key: 'items', kind: 'list', label: 'Cards', itemLabel: 'Card', max: 40, addLabel: 'Add a card',
        fields: [
          text('name', 'Name', 80, { required: true }), text('price', 'Price (optional), for example "$3 each" or "$36 / dozen"', 40),
          area('description', 'Description', 400), photo('image', 'Photo (optional)'),
        ],
        blank: { name: '', price: '', description: '', image: '' },
      },
    ],
    defaults: { eyebrow: '', heading: 'Our cupcakes', intro: '', items: [{ name: 'New card', price: '', description: '', image: '' }] },
  },
  steps: {
    label: 'Steps',
    description: 'Numbered steps, such as how ordering works.',
    fields: [
      ...HEADING_FIELDS, text('heading', 'Heading', 120, { required: true }), area('intro', 'Text', 600),
      {
        key: 'items', kind: 'list', label: 'Steps', itemLabel: 'Step', max: 10, addLabel: 'Add a step',
        fields: [text('title', 'Title', 80, { required: true }), area('text', 'Text', 400)],
        blank: { title: '', text: '' },
      },
    ],
    defaults: { eyebrow: '', heading: 'How it works', intro: '', items: [{ title: 'First step', text: '' }] },
  },
  contact: {
    label: 'Contact form',
    description: 'The inquiry form, with a heading, text and your email address. One per page.',
    single: true,
    fields: [...HEADING_FIELDS, text('heading', 'Heading', 120, { required: true }), area('intro', 'Text', 800), text('emailPrompt', 'Text before the email address', 120)],
    defaults: { eyebrow: '', heading: 'Get in touch', intro: '', emailPrompt: 'Prefer email? Write to' },
  },
};
const BACKGROUNDS = ['auto', 'plain', 'tinted'];
// Link names given automatically to new blocks.
const ANCHOR_BASE = { hero: 'top-banner', text: 'text', imageText: 'photo-text', gallery: 'gallery', cards: 'cards', steps: 'steps', contact: 'contact' };

const clone = (value) => JSON.parse(JSON.stringify(value));

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, key) => (o && typeof o === 'object' ? o[key] : undefined), obj);
}

// ---------- The original page (version 1) ----------

const V1_DEFAULT = Object.freeze({
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
const V1_SECTIONS = ['gallery', 'flavors', 'ordering'];

// Turns version-1 content into pages and blocks. Missing fields take the original page's values,
// as they did before. Validation happens afterwards, in normalizeContent.
function upgradeV1(raw) {
  const v = (dotted) => {
    const value = getPath(raw, dotted);
    return value === undefined ? clone(getPath(V1_DEFAULT, dotted)) : value;
  };
  const visible = (id) => !(raw[id] && typeof raw[id] === 'object' && raw[id].visible === false);
  const order = [...new Set((Array.isArray(raw.order) ? raw.order : []).filter((id) => V1_SECTIONS.includes(id)))];
  for (const id of V1_SECTIONS) if (!order.includes(id)) order.push(id);
  // The second banner button went to the gallery, or to the first visible section when it was hidden.
  const secondTarget = visible('gallery') ? 'gallery' : order.find(visible);

  const sections = {
    gallery: {
      id: 'gallery', type: 'gallery', visible: visible('gallery'), anchor: 'gallery', background: 'auto',
      eyebrow: v('gallery.eyebrow'), heading: v('gallery.heading'), intro: v('gallery.intro'),
      source: v('gallery.source'), photos: v('gallery.photos'), followButton: v('gallery.followButton'),
    },
    flavors: {
      id: 'flavors', type: 'cards', visible: visible('flavors'), anchor: 'flavors', background: 'auto',
      eyebrow: v('flavors.eyebrow'), heading: v('flavors.heading'), intro: v('flavors.intro'), items: v('flavors.items'),
    },
    ordering: {
      id: 'ordering', type: 'steps', visible: visible('ordering'), anchor: 'ordering', background: 'auto',
      eyebrow: v('ordering.eyebrow'), heading: v('ordering.heading'), intro: v('ordering.intro'), items: v('ordering.steps'),
    },
  };
  const blocks = [
    {
      id: 'hero', type: 'hero', visible: true, anchor: '',
      eyebrow: v('hero.eyebrow'), heading: v('hero.heading'), lead: v('hero.lead'), image: v('hero.image'),
      primaryButton: { label: v('hero.primaryButton'), target: 'block:home:contact' },
      secondaryButton: { label: v('hero.secondaryButton'), target: secondTarget ? `block:home:${secondTarget}` : '' },
    },
    ...order.map((id) => sections[id]),
    {
      id: 'contact', type: 'contact', visible: true, anchor: 'contact', background: 'auto',
      eyebrow: v('contact.eyebrow'), heading: v('contact.heading'), intro: v('contact.intro'), emailPrompt: v('contact.emailPrompt'),
    },
  ];
  const menu = order.map((id) => ({ label: v(`${id}.navLabel`), target: `block:home:${id}`, style: 'link' }));
  menu.push({ label: v('contact.navLabel'), target: 'block:home:contact', style: 'button' });
  return {
    site: {
      brand: { name: v('brand.name'), tagline: v('brand.tagline') },
      links: { instagramUrl: v('links.instagramUrl'), email: v('links.email') },
      siteUrl: v('seo.siteUrl'),
      menu,
    },
    theme: raw.theme,
    pages: [{
      id: 'home', slug: '', title: 'Home',
      seo: { title: v('seo.title'), description: v('seo.description'), shareImage: v('seo.shareImage') },
      blocks,
    }],
  };
}

// ---------- Validation ----------

function cleanText(value, label, max, required, multiline, errors) {
  let result = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  result = result.replace(/\r\n?/g, '\n');
  // Control characters other than newline are never valid in page text. They are removed before
  // trimming, so text made only of invisible characters counts as empty.
  result = result.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  result = multiline ? result.split('\n').map((line) => line.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim() : result.replace(/\s+/g, ' ').trim();
  if (required && !result) errors.push(`${label} can't be empty.`);
  if (result.length > max) errors.push(`${label} is too long (${result.length} characters; the limit is ${max}).`);
  return result;
}

const pageName = (page) => (page.id === 'home' ? 'Home page' : `"${page.title || page.slug || 'Untitled'}" page`);

// Returns { content, errors }. The result always has every field, so the renderer never sees gaps.
// options.photos: Map of existing photo ids. options.missingPhotos: 'error' (saving) or 'drop'
// (loading old versions): with 'drop', photos and links to pages or blocks that no longer exist are
// quietly left out instead of being errors.
function normalizeContent(raw, { photos = null, missingPhotos = 'error' } = {}) {
  const errors = [];
  let input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!Array.isArray(input.pages)) input = upgradeV1(input);
  const lenient = missingPhotos === 'drop';
  // Button and menu links, checked once every page and block is known.
  const links = [];

  const photoRef = (value, label) => {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || !PHOTO_ID.test(value)) {
      errors.push(`${label}: invalid photo.`);
      return '';
    }
    if (photos && !photos.has(value)) {
      if (!lenient) errors.push(`${label}: that photo was deleted. Choose another one.`);
      return '';
    }
    return value;
  };

  const targetRef = (value, label, onMissing) => {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || !TARGET.test(value)) {
      errors.push(`${label}: invalid link.`);
      return '';
    }
    links.push({ target: value, label, onMissing });
    return value;
  };

  function normalizeField(field, rawValue, defaultValue, where) {
    const value = rawValue === undefined ? clone(defaultValue) : rawValue;
    const label = `${where}: ${field.label}`;
    switch (field.kind) {
      case 'text': return cleanText(value, label, field.max, field.required, false, errors);
      case 'textarea': return cleanText(value, label, field.max, field.required, true, errors);
      case 'photo': return photoRef(value, label);
      case 'choice': return field.options.some(([key]) => key === value) ? value : defaultValue;
      case 'button': {
        const b = value && typeof value === 'object' ? value : {};
        const result = { label: cleanText(b.label, `${label} text`, 40, false, false, errors), target: '' };
        result.target = targetRef(b.target, label, () => {
          result.target = '';
        });
        return result;
      }
      case 'photos': {
        if (!Array.isArray(value)) {
          errors.push(`${label}: invalid photo list.`);
          return [];
        }
        if (value.length > field.max) errors.push(`${label}: at most ${field.max} photos.`);
        const ids = value.slice(0, field.max).map((id, i) => photoRef(id, `${label} ${i + 1}`)).filter(Boolean);
        return [...new Set(ids)];
      }
      case 'list': {
        if (!Array.isArray(value)) {
          errors.push(`${label}: invalid list.`);
          return [];
        }
        if (value.length > field.max) errors.push(`${where}: there can be at most ${field.max} ${field.label.toLowerCase()}.`);
        return value.slice(0, field.max).map((item, i) => {
          const source = item && typeof item === 'object' ? item : {};
          const result = {};
          for (const sub of field.fields) {
            result[sub.key] = normalizeField(sub, source[sub.key], field.blank[sub.key], `${where}, ${field.itemLabel.toLowerCase()} ${i + 1}`);
          }
          return result;
        });
      }
      default: return '';
    }
  }

  function normalizeBlock(rawBlock, where, seenIds) {
    const source = rawBlock && typeof rawBlock === 'object' ? rawBlock : {};
    const type = BLOCK_TYPES[source.type];
    if (!type) {
      errors.push(`${where}: unknown kind of block.`);
      return null;
    }
    const id = typeof source.id === 'string' && ITEM_ID.test(source.id) ? source.id : '';
    if (!id || seenIds.has(id)) {
      errors.push(`${where}: invalid block id.`);
      return null;
    }
    seenIds.add(id);
    const block = { id, type: source.type, visible: source.visible !== false, anchor: '' };
    if (type.background !== false) block.background = BACKGROUNDS.includes(source.background) ? source.background : 'auto';
    const anchor = typeof source.anchor === 'string' ? source.anchor.trim().toLowerCase() : '';
    if (anchor) {
      if (!ANCHOR.test(anchor)) errors.push(`${where}: link name must start with a letter and use only a-z, 0-9 and dashes.`);
      else if (RESERVED_ANCHORS.includes(anchor)) errors.push(`${where}: the link name "${anchor}" is used by the page itself. Choose another.`);
      else block.anchor = anchor;
    }
    for (const field of type.fields) block[field.key] = normalizeField(field, source[field.key], type.defaults[field.key], where);
    if (source.type === 'text' && !block.heading && !block.body) errors.push(`${where}: add a heading or some text.`);
    return block;
  }

  function normalizePage(rawPage, index, seenPageIds, seenSlugs) {
    const source = rawPage && typeof rawPage === 'object' ? rawPage : {};
    const id = typeof source.id === 'string' && ITEM_ID.test(source.id) ? source.id : '';
    if (!id || seenPageIds.has(id)) {
      errors.push(`Page ${index + 1}: invalid page id.`);
      return null;
    }
    seenPageIds.add(id);
    const home = id === 'home';
    const page = { id, slug: '', title: '', seo: {}, blocks: [] };
    page.title = cleanText(source.title === undefined && home ? 'Home' : source.title, `Page ${index + 1}: name`, 40, true, false, errors);
    const where = pageName(page);
    if (!home) {
      const slug = typeof source.slug === 'string' ? source.slug.trim().toLowerCase() : '';
      if (!SLUG.test(slug) || slug.length > 60) errors.push(`${where}: the web address can use only a-z, 0-9 and single dashes, for example "about-us".`);
      else if (RESERVED_SLUGS.includes(slug)) errors.push(`${where}: the web address "/${slug}" is used by the website itself. Choose another.`);
      else if (seenSlugs.has(slug)) errors.push(`${where}: another page already uses the web address "/${slug}".`);
      else {
        page.slug = slug;
        seenSlugs.add(slug);
      }
    }
    const seo = source.seo && typeof source.seo === 'object' ? source.seo : {};
    page.seo.title = cleanText(seo.title, `${where}: browser tab title`, 70, true, false, errors);
    page.seo.description = cleanText(seo.description, `${where}: search engine description`, 300, true, false, errors);
    page.seo.shareImage = photoRef(seo.shareImage, `${where}: link preview photo`);

    const rawBlocks = Array.isArray(source.blocks) ? source.blocks : [];
    if (!Array.isArray(source.blocks)) errors.push(`${where}: invalid list of blocks.`);
    if (rawBlocks.length > MAX_BLOCKS) errors.push(`${where}: a page can have at most ${MAX_BLOCKS} blocks.`);
    const seenIds = new Set();
    const counts = {};
    for (const rawBlock of rawBlocks.slice(0, MAX_BLOCKS)) {
      const typeKey = rawBlock && BLOCK_TYPES[rawBlock.type] ? rawBlock.type : null;
      counts[typeKey] = (counts[typeKey] || 0) + 1;
      const label = typeKey ? BLOCK_TYPES[typeKey].label : 'Block';
      const total = rawBlocks.filter((b) => b && b.type === typeKey).length;
      const block = normalizeBlock(rawBlock, `${where}, ${label}${total > 1 ? ` ${counts[typeKey]}` : ''}`, seenIds);
      if (block) page.blocks.push(block);
    }
    for (const [key, type] of Object.entries(BLOCK_TYPES)) {
      if (type.single && page.blocks.filter((b) => b.type === key).length > 1) {
        errors.push(`${where}: a page can have only one ${type.label.toLowerCase()} block.`);
      }
    }
    // Link names: duplicates are errors; blocks without one get one automatically.
    const used = new Set();
    for (const block of page.blocks) {
      if (!block.anchor) continue;
      if (used.has(block.anchor)) {
        errors.push(`${where}: two blocks use the link name "${block.anchor}".`);
        block.anchor = '';
      } else used.add(block.anchor);
    }
    for (const block of page.blocks) {
      if (block.anchor || BLOCK_TYPES[block.type].anchor === 'optional') continue;
      const base = ANCHOR_BASE[block.type];
      let name = base;
      for (let n = 2; used.has(name) || RESERVED_ANCHORS.includes(name); n += 1) name = `${base}-${n}`;
      block.anchor = name;
      used.add(name);
    }
    return page;
  }

  // Site-wide details shown on every page.
  const site = input.site && typeof input.site === 'object' ? input.site : {};
  const brand = site.brand && typeof site.brand === 'object' ? site.brand : {};
  const linkInput = site.links && typeof site.links === 'object' ? site.links : {};
  const content = {
    site: {
      brand: {
        name: cleanText(brand.name, 'Business name', 60, true, false, errors),
        tagline: cleanText(brand.tagline, 'Footer tagline', 120, false, false, errors),
      },
      links: {
        instagramUrl: cleanText(linkInput.instagramUrl, 'Instagram link', 200, false, false, errors),
        email: cleanText(linkInput.email, 'Contact email', 200, true, false, errors),
      },
      siteUrl: cleanText(site.siteUrl, 'Website address', 200, true, false, errors),
      menu: [],
    },
    theme: null,
    pages: [],
  };
  const { links: siteLinks } = content.site;
  if (siteLinks.instagramUrl) {
    let ok = false;
    try {
      const url = new URL(siteLinks.instagramUrl);
      ok = url.protocol === 'https:' && /(^|\.)instagram\.com$/i.test(url.hostname);
    } catch {
      ok = false;
    }
    if (!ok) errors.push('Instagram link must be an https://www.instagram.com/... address.');
  }
  if (siteLinks.email && !EMAIL.test(siteLinks.email)) errors.push('Contact email must be an email address.');
  try {
    const url = new URL(content.site.siteUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username) throw new Error('bad');
    content.site.siteUrl = url.origin;
  } catch {
    if (content.site.siteUrl) errors.push('Website address must look like https://frostedharmony.com');
  }

  // Pages: the home page always comes first.
  const rawPages = input.pages;
  if (rawPages.length > MAX_PAGES) errors.push(`The website can have at most ${MAX_PAGES} pages.`);
  const seenPageIds = new Set();
  const seenSlugs = new Set();
  const pages = rawPages.slice(0, MAX_PAGES).map((p, i) => normalizePage(p, i, seenPageIds, seenSlugs)).filter(Boolean);
  let home = pages.find((p) => p.id === 'home');
  if (!home) {
    errors.push('The home page is missing.');
    home = normalizePage(upgradeV1({}).pages[0], 0, new Set(), new Set());
  }
  content.pages = [home, ...pages.filter((p) => p !== home)];

  const rawMenu = Array.isArray(site.menu) ? site.menu : [];
  if (site.menu !== undefined && !Array.isArray(site.menu)) errors.push('Invalid menu.');
  if (rawMenu.length > MAX_MENU) errors.push(`The menu can have at most ${MAX_MENU} items.`);
  for (const [i, item] of rawMenu.slice(0, MAX_MENU).entries()) {
    const source = item && typeof item === 'object' ? item : {};
    const entry = {
      label: cleanText(source.label, `Menu item ${i + 1}: text`, 30, true, false, errors),
      target: '',
      style: source.style === 'button' ? 'button' : 'link',
    };
    entry.target = targetRef(source.target, `Menu item ${i + 1}${entry.label ? ` ("${entry.label}")` : ''}`, () => {
      entry.removed = true;
    });
    if (!entry.target && !entry.removed) errors.push(`Menu item ${i + 1}: choose where it goes.`);
    content.site.menu.push(entry);
  }

  // Every link must point at a page or block that exists.
  const pageIndex = new Map(content.pages.map((p) => [p.id, new Set(p.blocks.map((b) => b.id))]));
  for (const link of links) {
    const [kind, pageId, blockId] = link.target.split(':');
    const exists = kind === 'page' ? pageIndex.has(pageId) : kind === 'block' ? Boolean(pageIndex.get(pageId) && pageIndex.get(pageId).has(blockId)) : true;
    if (exists) continue;
    if (lenient) link.onMissing();
    else errors.push(`${link.label}: the page or block it links to no longer exists. Choose another.`);
  }
  content.site.menu = content.site.menu.filter((item) => !item.removed);

  const design = normalizeTheme(input.theme, photoRef);
  content.theme = design.theme;
  errors.push(...design.errors);

  return { content, errors };
}

const DEFAULT_CONTENT = (() => {
  const { content, errors } = normalizeContent(V1_DEFAULT);
  if (errors.length) throw new Error(`Default content is invalid: ${errors.join(' ')}`);
  return Object.freeze(content);
})();

// For the admin portal's editor: the block types, without functions.
const BLOCK_TYPES_PUBLIC = Object.entries(BLOCK_TYPES).map(([type, spec]) => ({
  type, label: spec.label, description: spec.description, single: Boolean(spec.single),
  anchor: spec.anchor || 'required', background: spec.background !== false, fields: spec.fields, defaults: spec.defaults,
}));

// Where each photo appears in a piece of content, as readable labels ("Home page: Gallery").
function photoUsage(content) {
  const usage = new Map();
  const add = (id, label) => {
    if (!id) return;
    if (!usage.has(id)) usage.set(id, []);
    if (!usage.get(id).includes(label)) usage.get(id).push(label);
  };
  if (!content) return usage;
  const site = Array.isArray(content.pages) ? content : normalizeContent(content, { missingPhotos: 'drop' }).content;
  add(site.theme && site.theme.logo, 'Logo');
  for (const page of site.pages) {
    const name = page.id === 'home' ? 'Home page' : `${page.title} page`;
    add(page.seo && page.seo.shareImage, `${name}: link preview`);
    for (const block of page.blocks) {
      const type = BLOCK_TYPES[block.type];
      if (!type) continue;
      const where = `${name}: ${type.label}`;
      for (const field of type.fields) {
        if (field.kind === 'photo') add(block[field.key], where);
        if (field.kind === 'photos') for (const id of block[field.key] || []) add(id, where);
        if (field.kind === 'list') {
          for (const item of block[field.key] || []) {
            for (const sub of field.fields) if (sub.kind === 'photo') add(item[sub.key], `${where}, ${item.name || item.title || 'unnamed'}`);
          }
        }
      }
    }
  }
  return usage;
}

// assets(content) builds files the page links to (theme stylesheet, logo icons) and returns their URLs.
function createContentStore({ dir, siteDir, render, photos = () => null, assets = async () => ({}), now = () => Date.now() }) {
  const historyDir = path.join(dir, 'history');
  const draftFile = path.join(dir, 'draft.json');
  const publishedFile = path.join(dir, 'published.json');
  const pageFile = path.join(siteDir, 'index.html');
  // Every page other than the home page, as <slug>.html. nginx serves /<slug> from here.
  const pagesDir = path.join(siteDir, 'pages');
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

  async function removePageFiles(keep = new Set()) {
    let names = [];
    try {
      names = await fsp.readdir(pagesDir);
    } catch {
      return;
    }
    for (const name of names) if (name.endsWith('.html') && !keep.has(name)) await fsp.rm(path.join(pagesDir, name), { force: true });
  }

  async function writePage(content) {
    // Linked files are written first, so a new page never points at something missing. The other
    // pages come before the home page, and removed pages go last, so links never point at nothing.
    const linked = await assets(content);
    const library = photos();
    await fsp.mkdir(pagesDir, { recursive: true, mode: 0o755 });
    await fsp.chmod(pagesDir, 0o755).catch(() => {});
    const keep = new Set();
    for (const page of content.pages) {
      if (page.id === 'home') continue;
      const name = `${page.slug}.html`;
      await writeFileAtomic(path.join(pagesDir, name), render(content, { pageId: page.id, photos: library, assets: linked }), 0o644);
      keep.add(name);
    }
    await writeFileAtomic(pageFile, render(content, { pageId: 'home', photos: library, assets: linked }), 0o644);
    await removePageFiles(keep);
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

  // ---------- Backups ----------

  async function exportAll() {
    const entries = [];
    let files = [];
    try {
      files = (await fsp.readdir(historyDir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      files = [];
    }
    for (const file of files) {
      const entry = await readJson(path.join(historyDir, file), null);
      if (entry) entries.push(entry);
    }
    return { draft: clone(draft), published: published ? clone(published) : null, history: entries };
  }

  const HISTORY_ID = /^[0-9]+-[A-Za-z0-9]+$/;
  const shortText = (value) => (typeof value === 'string' ? value.slice(0, 64) : null);

  // Checks a backup's page content without changing anything. Photos that no longer exist are left out.
  function checkImport(raw) {
    if (!raw || typeof raw !== 'object') return { error: 'The backup has no page content.' };
    const tidy = (content, label) => {
      const result = normalizeContent(content, { photos: photos(), missingPhotos: 'drop' });
      return result.errors.length ? { error: `${label}: ${result.errors.join(' ')}` } : { content: result.content };
    };
    let livePart = null;
    if (raw.published) {
      const checked = tidy(raw.published.content, 'Live page');
      if (checked.error) return checked;
      livePart = { content: checked.content, at: shortText(raw.published.at), by: shortText(raw.published.by) };
    }
    const draftRaw = raw.draft && raw.draft.content ? raw.draft.content : livePart ? livePart.content : DEFAULT_CONTENT;
    const draftChecked = tidy(draftRaw, 'Draft');
    if (draftChecked.error) return draftChecked;
    const entries = [];
    let skipped = 0;
    for (const entry of Array.isArray(raw.history) ? raw.history.slice(-(HISTORY_KEEP + 1)) : []) {
      const checked = entry && typeof entry.id === 'string' && HISTORY_ID.test(entry.id) ? tidy(entry.content, 'Version') : { error: 'bad' };
      if (checked.error) {
        skipped += 1;
        continue;
      }
      entries.push({ id: entry.id, at: shortText(entry.at), by: shortText(entry.by), label: entry.label === 'original' ? 'original' : 'published', content: checked.content });
    }
    return {
      draft: { content: draftChecked.content, savedAt: shortText(raw.draft && raw.draft.savedAt), savedBy: shortText(raw.draft && raw.draft.savedBy) },
      published: livePart,
      history: entries,
      notes: skipped ? [`${skipped} old published version${skipped === 1 ? ' was' : 's were'} left out because ${skipped === 1 ? 'it' : 'they'} could not be read.`] : [],
    };
  }

  // Replaces the draft, the live page and the published versions with checked data from checkImport.
  async function applyImport(checked) {
    for (const file of await fsp.readdir(historyDir)) {
      if (file.endsWith('.json')) await fsp.rm(path.join(historyDir, file), { force: true });
    }
    for (const entry of checked.history) await writeJson(path.join(historyDir, `${entry.id}.json`), entry);
    if (checked.published) {
      await writePage(checked.published.content);
      await writeJson(publishedFile, checked.published);
    } else {
      // Nothing was published when the backup was made: the original page comes back.
      await fsp.rm(publishedFile, { force: true });
      await fsp.rm(pageFile, { force: true });
      await removePageFiles();
    }
    published = checked.published;
    // A new revision number, so anyone with the editor open is told to reload instead of overwriting.
    const next = { revision: draft.revision + 1, ...checked.draft };
    await writeJson(draftFile, next);
    draft = next;
  }

  return {
    load,
    state,
    saveDraft: (raw, revision, actor) => exclusive(() => saveDraft(raw, revision, actor)),
    publish: (actor, revision) => exclusive(() => publish(actor, revision)),
    discard: (actor) => exclusive(() => discard(actor)),
    restore: (id, options, actor) => exclusive(() => restore(id, options, actor)),
    // Not queued: the backup module runs these inside exclusive() itself.
    exportAll,
    checkImport,
    applyImport,
    history,
    regenerate,
    usage,
    exclusive,
    preview: () => draft.content,
    pageFile,
    pagesDir,
  };
}

module.exports = {
  DEFAULT_CONTENT, V1_DEFAULT, BLOCK_TYPES, BLOCK_TYPES_PUBLIC, RESERVED_SLUGS, RESERVED_ANCHORS, MAX_PAGES, MAX_BLOCKS, MAX_MENU,
  normalizeContent, photoUsage, createContentStore,
};
