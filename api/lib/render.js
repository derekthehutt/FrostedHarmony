'use strict';

// Builds the public index.html from page content. Every piece of text is HTML-escaped; the only
// markup comes from this file, so nothing typed in the admin portal can inject HTML or scripts.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
// Line breaks typed in multi-line boxes become <br>.
const text = (value) => esc(value).replace(/\n/g, '<br>\n');

const CUPCAKE_SVG = `<svg viewBox="0 0 200 220" class="cupcake-illustration">
            <circle cx="100" cy="28" r="12" fill="#d94f6b"/>
            <path d="M100 18c4-10 12-14 18-14" stroke="#5a8f6a" stroke-width="4" fill="none" stroke-linecap="round"/>
            <path d="M40 110c-18 0-24-22-8-30-6-20 14-34 30-24 4-22 32-28 44-10 12-16 40-8 40 14 18-4 30 16 18 30 14 10 6 30-12 30z" fill="#f7c6d0"/>
            <path d="M48 92c10 6 30 8 52 4s38-2 52 4" stroke="#ef9fb2" stroke-width="5" fill="none" stroke-linecap="round"/>
            <path d="M34 110h132l-18 96a10 10 0 0 1-10 8H62a10 10 0 0 1-10-8z" fill="#8a5a44"/>
            <path d="M66 112l6 102M100 112v102M134 112l-6 102" stroke="#6e4535" stroke-width="5"/>
            <circle cx="70" cy="70" r="3" fill="#a8d5ba"/>
            <circle cx="120" cy="58" r="3" fill="#fbe38e"/>
            <circle cx="140" cy="84" r="3" fill="#a8d5ba"/>
            <circle cx="88" cy="50" r="3" fill="#fbe38e"/>
          </svg>`;

const INQUIRY_FORM = `<form class="inquiry-form" id="inquiry-form" novalidate>
          <div class="form-row">
            <label for="name">Your name <span aria-hidden="true">*</span></label>
            <input id="name" name="name" type="text" autocomplete="name" maxlength="100" required>
          </div>
          <div class="form-row two-col">
            <div>
              <label for="email">Email <span aria-hidden="true">*</span></label>
              <input id="email" name="email" type="email" autocomplete="email" maxlength="200" required>
            </div>
            <div>
              <label for="phone">Phone (optional)</label>
              <input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="40">
            </div>
          </div>
          <div class="form-row">
            <label for="inquiryType">What can we help with?</label>
            <select id="inquiryType" name="inquiryType">
              <option value="pricing">Pricing</option>
              <option value="custom-order">Custom order</option>
              <option value="event">Event or party</option>
              <option value="general">General question</option>
            </select>
          </div>
          <div class="form-row two-col">
            <div>
              <label for="eventDate">Event date (optional)</label>
              <input id="eventDate" name="eventDate" type="date">
            </div>
            <div>
              <label for="quantity">How many cupcakes? (optional)</label>
              <input id="quantity" name="quantity" type="text" inputmode="numeric" maxlength="40" placeholder="e.g. 2 dozen">
            </div>
          </div>
          <div class="form-row">
            <label for="message">Message <span aria-hidden="true">*</span></label>
            <textarea id="message" name="message" rows="5" maxlength="3000" required
              placeholder="Tell us about your event, flavors, colors or theme..."></textarea>
          </div>
          <!-- Spam trap: hidden from people, often filled in by bots. Its name and label avoid words
               (website, url, company...) that browser autofill recognizes. -->
          <div class="hp-field" aria-hidden="true">
            <label for="fh_trap">Do not type here</label>
            <input id="fh_trap" name="fh_trap" type="text" tabindex="-1" autocomplete="off" data-lpignore="true" data-1p-ignore>
          </div>
          <button class="button" type="submit">Send inquiry</button>
          <p class="form-status" id="form-status" role="status" aria-live="polite"></p>
        </form>`;

function heading(section, { left = false } = {}) {
  return `<div class="section-heading${left ? ' left' : ''}">
          ${section.eyebrow ? `<p class="eyebrow">${esc(section.eyebrow)}</p>` : ''}
          <h2>${esc(section.heading)}</h2>
          ${section.intro ? `<p>${text(section.intro)}</p>` : ''}
        </div>`;
}

function gallerySection(c, tinted) {
  return `<section id="gallery" class="section${tinted ? ' section-tinted' : ''}">
      <div class="container">
        ${heading(c.gallery)}
        <div class="gallery-grid" id="gallery-grid" aria-live="polite">
          <p class="gallery-status">Loading photos...</p>
        </div>
        ${c.gallery.followButton && c.links.instagramUrl ? `<p class="center">
          <a class="button button-outline" data-instagram-link href="#" target="_blank" rel="noopener">${esc(c.gallery.followButton)}</a>
        </p>` : ''}
      </div>
    </section>`;
}

function flavorsSection(c, tinted) {
  const cards = c.flavors.items.map((item) => `<article class="card">
            <h3>${esc(item.name)}</h3>
            ${item.description ? `<p>${text(item.description)}</p>` : ''}
            ${item.price ? `<p class="card-price">${esc(item.price)}</p>` : ''}
          </article>`).join('\n          ');
  return `<section id="flavors" class="section${tinted ? ' section-tinted' : ''}">
      <div class="container">
        ${heading(c.flavors)}
        <div class="card-grid">
          ${cards}
        </div>
      </div>
    </section>`;
}

function orderingSection(c, tinted) {
  const steps = c.ordering.steps.map((step) => `<li>
            <h3>${esc(step.title)}</h3>
            ${step.text ? `<p>${text(step.text)}</p>` : ''}
          </li>`).join('\n          ');
  return `<section id="ordering" class="section${tinted ? ' section-tinted' : ''}">
      <div class="container">
        ${heading(c.ordering)}
        <ol class="steps">
          ${steps}
        </ol>
      </div>
    </section>`;
}

function renderPage(content, { preview = false } = {}) {
  const c = content;
  const visible = c.order.filter((id) => c[id].visible);
  // Sections alternate between plain and tinted backgrounds, ending with the tinted contact section.
  const tintFor = (index) => (visible.length - index) % 2 === 0;
  const builders = { gallery: (i) => gallerySection(c, tintFor(i)), flavors: (i) => flavorsSection(c, tintFor(i)), ordering: (i) => orderingSection(c, tintFor(i)) };
  const sections = visible.map((id, i) => builders[id](i)).join('\n\n    ');
  const navLinks = visible.map((id) => `<a href="#${id}">${esc(c[id].navLabel)}</a>`).join('\n        ');
  const secondaryTarget = c.gallery.visible ? '#gallery' : visible[0] ? `#${visible[0]}` : '';
  const emailLink = `<a href="mailto:${esc(c.links.email)}">${esc(c.links.email)}</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(c.seo.title)}</title>
  <meta name="description" content="${esc(c.seo.description)}">
${preview ? '  <meta name="robots" content="noindex, nofollow">\n' : ''}  <link rel="icon" href="/images/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
  <script src="/script.js" defer></script>
</head>
<body data-instagram-url="${esc(c.links.instagramUrl)}"${preview ? ' data-preview="1"' : ''}>
${preview ? '  <div class="preview-banner" role="status">Preview of your unpublished changes. Visitors can\'t see this yet, and the inquiry form is turned off.</div>\n' : ''}
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="#top" aria-label="${esc(c.brand.name)} home">
        <img src="/images/favicon.svg" alt="" width="36" height="36">
        <span>${esc(c.brand.name)}</span>
      </a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">
        <span class="sr-only">Open menu</span>
        <span class="nav-toggle-bar"></span>
      </button>
      <nav id="site-nav" class="site-nav">
        ${navLinks}
        <a href="#contact" class="button button-small">${esc(c.contact.navLabel)}</a>
      </nav>
    </div>
  </header>

  <main id="top">
    <section class="hero">
      <div class="container hero-inner">
        <div class="hero-text">
          ${c.hero.eyebrow ? `<p class="eyebrow">${esc(c.hero.eyebrow)}</p>` : ''}
          <h1>${esc(c.hero.heading)}</h1>
          ${c.hero.lead ? `<p class="lead">${text(c.hero.lead)}</p>` : ''}
          <div class="hero-actions">
            <a class="button" href="#contact">${esc(c.hero.primaryButton)}</a>
            ${c.hero.secondaryButton && secondaryTarget ? `<a class="button button-outline" href="${secondaryTarget}">${esc(c.hero.secondaryButton)}</a>` : ''}
          </div>
        </div>
        <div class="hero-art" aria-hidden="true">
          ${CUPCAKE_SVG}
        </div>
      </div>
    </section>

    ${sections}

    <section id="contact" class="section section-tinted">
      <div class="container contact-inner">
        <div class="section-heading left">
          ${c.contact.eyebrow ? `<p class="eyebrow">${esc(c.contact.eyebrow)}</p>` : ''}
          <h2>${esc(c.contact.heading)}</h2>
          ${c.contact.intro ? `<p>${text(c.contact.intro)}</p>` : ''}
          <p class="contact-email">
            ${esc(c.contact.emailPrompt)}
            ${emailLink}
          </p>
        </div>

        ${INQUIRY_FORM}
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container footer-inner">
      <p>&copy; <span id="year"></span> ${esc(c.brand.name)}.${c.brand.tagline ? ` ${esc(c.brand.tagline)}` : ''}</p>
      <p class="footer-links">
        ${emailLink}
        ${c.links.instagramUrl ? '<a data-instagram-link href="#" target="_blank" rel="noopener">Instagram</a>' : ''}
      </p>
    </div>
  </footer>
</body>
</html>
`;
}

module.exports = { renderPage, esc };
