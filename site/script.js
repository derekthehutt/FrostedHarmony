'use strict';

(function () {
  const instagramUrl = document.body.dataset.instagramUrl || 'https://www.instagram.com/';

  document.querySelectorAll('[data-instagram-link]').forEach((link) => {
    link.href = instagramUrl;
  });
  document.getElementById('year').textContent = String(new Date().getFullYear());

  // Mobile menu
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });

  // Gallery: your own photos are already in the page. Depending on data-gallery-source
  // ("mixed" by default, "photos" or "instagram"), Instagram posts are added after them, with
  // site/gallery.json as a last fallback.
  const grid = document.getElementById('gallery-grid');

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function shortCaption(text) {
    const firstLine = (text || '').split('\n')[0].trim();
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }

  function showEmptyGallery() {
    const empty = document.createElement('p');
    empty.className = 'gallery-status';
    empty.textContent = 'New photos are coming soon. Follow us on Instagram to see our latest cupcakes!';
    grid.replaceChildren(empty);
  }

  function addTiles(items) {
    for (const item of items) {
      const tile = document.createElement(item.permalink ? 'a' : 'div');
      tile.className = 'gallery-item';
      if (item.permalink) {
        tile.href = item.permalink;
        tile.target = '_blank';
        tile.rel = 'noopener';
      }
      const img = document.createElement('img');
      img.src = item.image;
      img.alt = shortCaption(item.caption) || 'Frosted Harmony cupcakes';
      img.loading = 'lazy';
      img.decoding = 'async';
      tile.append(img);
      if (item.isVideo) {
        const badge = document.createElement('span');
        badge.className = 'video-badge';
        badge.textContent = 'Video';
        tile.append(badge);
      }
      grid.append(tile);
    }
  }

  async function loadGallery() {
    const source = grid.dataset.gallerySource || 'mixed';
    const ownPhotos = grid.querySelectorAll('.gallery-item').length;
    if (source === 'photos') {
      if (!ownPhotos) showEmptyGallery();
      return;
    }
    let items = [];
    try {
      items = (await fetchJson('/api/instagram')).items || [];
    } catch {
      // API unavailable: fall back below.
    }
    if (!items.length && !ownPhotos) {
      try {
        items = await fetchJson('/gallery.json');
      } catch {
        items = [];
      }
    }
    items = Array.isArray(items) ? items : [];
    if (!ownPhotos) grid.replaceChildren();
    addTiles(items);
    if (!grid.children.length) showEmptyGallery();
  }

  if (grid) loadGallery();

  // Inquiry form (only on pages with a contact form block)
  const form = document.getElementById('inquiry-form');
  if (!form) return;
  const status = document.getElementById('form-status');
  const submit = form.querySelector('button[type="submit"]');

  const REQUEST_TIMEOUT_MS = 45000;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const requiredChecks = [
    { name: 'name', valid: (v) => v.length > 0, message: 'Please enter your name.' },
    { name: 'email', valid: (v) => EMAIL_PATTERN.test(v), message: 'Please enter a valid email address.' },
    { name: 'message', valid: (v) => v.length >= 10, message: 'Please tell us a little more in your message (at least 10 characters).' },
  ];

  function showStatus(message, kind) {
    status.textContent = message;
    status.className = `form-status ${kind}`;
  }

  // Read the live field values on every submit, so autofilled and edited values are always used.
  function readForm() {
    const data = {};
    for (const el of form.elements) {
      if (el.name) data[el.name] = typeof el.value === 'string' ? el.value.trim() : '';
    }
    return data;
  }

  function validate(data) {
    const problems = [];
    for (const check of requiredChecks) {
      const field = form.elements[check.name];
      const ok = check.valid(data[check.name] || '');
      field.setAttribute('aria-invalid', String(!ok));
      if (!ok) problems.push(check);
    }
    return problems;
  }

  // Clear a stale error as soon as the visitor edits or autofill changes a field.
  const clearFieldError = (event) => {
    if (event.target.getAttribute && event.target.getAttribute('aria-invalid') === 'true') {
      event.target.removeAttribute('aria-invalid');
    }
    if (status.classList.contains('error')) showStatus('', '');
  };
  form.addEventListener('input', clearFieldError);
  form.addEventListener('change', clearFieldError);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    // Admin portal preview pages show the form but must never send real inquiries.
    if (document.body.dataset.preview === '1') {
      showStatus('This is a preview, so the form is turned off.', 'error');
      return;
    }
    const data = readForm();

    const problems = validate(data);
    if (problems.length) {
      showStatus(problems.map((p) => p.message).join(' '), 'error');
      form.elements[problems[0].name].focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Sending...';
    showStatus('', '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
      form.reset();
      for (const check of requiredChecks) form.elements[check.name].removeAttribute('aria-invalid');
      showStatus('Thank you! Your message was sent. We will get back to you soon.', 'success');
    } catch (err) {
      const message = err.name === 'AbortError'
        ? 'Sending is taking too long. Please try again in a minute, or email us directly.'
        : err instanceof TypeError
          ? 'We could not reach the server. Check your connection and try again.'
          : err.message || 'Something went wrong. Please try again.';
      showStatus(message, 'error');
    } finally {
      clearTimeout(timer);
      submit.disabled = false;
      submit.textContent = 'Send inquiry';
    }
  });
})();
