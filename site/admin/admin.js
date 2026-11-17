'use strict';

// Admin portal. All text from the server is inserted with textContent, never as HTML.
(function () {
  const $ = (id) => document.getElementById(id);
  const views = ['view-loading', 'view-setup', 'view-login', 'view-app'];
  let csrf = null;
  let currentUser = null;
  let settingsCache = [];

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (name === 'className') node.className = value;
      else if (name === 'text') node.textContent = value;
      else if (name.startsWith('on')) node.addEventListener(name.slice(2).toLowerCase(), value);
      else if (value === true) node.setAttribute(name, '');
      else node.setAttribute(name, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function show(viewId) {
    for (const id of views) $(id).hidden = id !== viewId;
  }

  function formatTime(value) {
    if (!value) return 'never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function setResult(node, message, ok) {
    node.textContent = message || '';
    node.className = message ? (ok ? 'result-ok' : 'result-bad') : '';
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    let res;
    try {
      res = await fetch(`/api/admin${path}`, {
        method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') {
      showLogin('Your session ended. Please sign in again.');
      throw new ApiError(data.error || 'Please sign in.', 401);
    }
    if (!res.ok || data.ok === false) throw new ApiError(data.error || data.message || `Request failed (${res.status}).`, res.status);
    return data;
  }

  function withBusy(button, task) {
    return async (...args) => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await task(...args);
      } finally {
        button.disabled = false;
      }
    };
  }

  // ---------- Sign-in ----------

  function showLogin(notice) {
    csrf = null;
    currentUser = null;
    $('login-notice').hidden = !notice;
    $('login-notice').textContent = notice || '';
    $('login-error').textContent = '';
    $('login-password').value = '';
    show('view-login');
    $('login-username').focus();
  }

  const loginForm = $('login-form');
  const loginButton = loginForm.querySelector('button[type="submit"]');
  loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    withBusy(loginButton, async () => {
      $('login-error').textContent = '';
      const username = $('login-username').value.trim();
      const password = $('login-password').value;
      if (!username || !password) {
        $('login-error').textContent = 'Enter your username and password.';
        return;
      }
      loginButton.textContent = 'Signing in…';
      try {
        const data = await api('/login', { method: 'POST', body: { username, password } });
        csrf = data.csrf;
        currentUser = data.user;
        $('login-password').value = '';
        enterApp();
      } catch (err) {
        $('login-error').textContent = err.message;
        $('login-password').select();
      } finally {
        loginButton.textContent = 'Sign in';
      }
    })();
  });

  $('logout-button').addEventListener('click', async () => {
    try {
      await api('/logout', { method: 'POST', body: {} });
    } catch {
      // Signed out locally either way.
    }
    showLogin('You have signed out.');
  });

  // ---------- Navigation ----------

  const PAGES = { dashboard: loadDashboard, content: loadContent, photos: loadPhotos, settings: loadSettings, account: loadAccount };

  function currentPage() {
    const name = location.hash.replace('#', '');
    return PAGES[name] ? name : 'dashboard';
  }

  function route() {
    if (!currentUser) return;
    const page = currentPage();
    for (const section of document.querySelectorAll('[data-page-section]')) section.hidden = section.dataset.pageSection !== page;
    for (const link of document.querySelectorAll('.tabs a')) {
      if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    $('global-message').hidden = true;
    PAGES[page]().catch((err) => {
      if (err.status !== 401) showGlobal(err.message, false);
    });
  }

  function showGlobal(message, ok) {
    const node = $('global-message');
    node.textContent = message;
    node.className = `notice ${ok ? 'ok' : 'bad'}`;
    node.hidden = false;
  }

  function enterApp() {
    $('who-name').textContent = currentUser.username;
    $('password-username').value = currentUser.username;
    show('view-app');
    route();
  }

  window.addEventListener('hashchange', route);

  function renderProblems(node, problems) {
    node.replaceChildren();
    node.hidden = !problems || !problems.length;
    if (node.hidden) return;
    node.append(el('strong', { text: 'Needs attention:' }), el('ul', {}, problems.map((p) => el('li', { text: p }))));
  }

  // ---------- Dashboard ----------

  function statusCard(node, title, rows) {
    node.replaceChildren(el('h2', { text: title }), ...rows.filter(Boolean));
  }

  function pill(text, kind) {
    return el('span', { className: `pill ${kind}`, text });
  }

  async function loadDashboard() {
    const data = await api('/dashboard');
    const { email, instagram } = data.status;
    renderProblems($('problems'), data.problems);

    statusCard($('status-email'), 'Inquiry email', [
      el('div', { className: 'status-line' }, email.configured ? pill('Working', 'ok') : pill('Not set up', 'warn'),
        email.lastError ? pill('Last send failed', 'bad') : null),
      el('p', {}, 'Inquiries go to: ', el('strong', { text: email.sendTo || '(not set)' })),
      email.lastError ? el('p', { className: 'small-text', text: `${formatTime(email.lastError.at)}: ${email.lastError.message}` }) : null,
      el('a', { href: '#settings', className: 'link', text: 'Email settings' }),
    ]);

    let igPill = pill('Not connected', 'warn');
    if (instagram.configured) igPill = instagram.lastError ? pill('Problem', 'bad') : pill('Connected', 'ok');
    statusCard($('status-instagram'), 'Instagram gallery', [
      el('div', { className: 'status-line' }, igPill),
      el('p', { text: `${instagram.posts} posts shown. Last updated: ${formatTime(instagram.updatedAt)}.` }),
      instagram.lastError ? el('p', { className: 'small-text', text: `${formatTime(instagram.lastError.at)}: ${instagram.lastError.message}` }) : null,
      el('a', { href: '#settings', className: 'link', text: 'Instagram settings' }),
    ]);

    const inquiries = $('inquiries');
    if (!data.inquiries.length) {
      inquiries.replaceChildren(el('p', { className: 'muted', text: 'No inquiries yet.' }));
    } else {
      inquiries.replaceChildren(el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Received' }), el('th', { text: 'From' }), el('th', { text: 'Type' }))),
        el('tbody', {}, data.inquiries.map((q) => el('tr', {},
          el('td', { text: formatTime(q.receivedAt) }),
          el('td', {}, q.name || '', el('br'), el('span', { className: 'small-text', text: q.email || '' })),
          el('td', {}, q.type, q.spam ? el('span', {}, ' ', pill('Spam?', 'warn')) : null),
        )))));
    }

    const activity = $('activity');
    activity.replaceChildren(...(data.activity.length
      ? data.activity.map((a) => el('li', {},
        el('strong', { text: describeAction(a) }),
        el('div', { className: 'small-text', text: `${formatTime(a.at)}${a.user ? ` · ${a.user}` : ''}${a.ip ? ` · ${a.ip}` : ''}` })))
      : [el('li', { className: 'muted', text: 'No activity yet.' })]));
  }

  function describeAction(entry) {
    const details = entry.details || {};
    switch (entry.action) {
      case 'login': return 'Signed in';
      case 'logout': return 'Signed out';
      case 'login-failed': return details.reason === 'ip-limited' ? 'Sign-in blocked (too many attempts)' : `Failed sign-in${details.attempted ? ` as "${details.attempted}"` : ''}`;
      case 'settings-changed': return `Changed settings: ${(details.settings || []).join(', ')}`;
      case 'password-changed': return 'Changed password';
      case 'password-change-failed': return 'Password change failed';
      case 'sessions-revoked': return 'Signed out other devices';
      case 'test-email': return `Sent a test email (${details.ok ? 'worked' : 'failed'})`;
      case 'test-instagram': return `Tested Instagram (${details.ok ? 'worked' : 'failed'})`;
      case 'content-draft-saved': return 'Saved a page content draft';
      case 'content-published': return 'Published page changes';
      case 'content-draft-discarded': return 'Discarded the page content draft';
      case 'content-restored-to-draft': return 'Copied an older version into the draft';
      case 'content-restored-and-published': return 'Put an older version back live';
      case 'photo-uploaded': return 'Uploaded a photo';
      case 'photo-described': return 'Updated a photo description';
      case 'photo-deleted': return 'Deleted a photo';
      default: return entry.action;
    }
  }

  // ---------- Settings ----------

  const SOURCE_LABELS = { portal: ['Set here', 'ok'], env: ['From .env file', 'neutral'], default: ['Default', 'neutral'] };

  function inputFor(setting) {
    const id = `setting-${setting.name}`;
    if (setting.type === 'secret') {
      return el('input', {
        id, name: setting.name, type: 'password', autocomplete: 'new-password', spellcheck: 'false',
        placeholder: setting.isSet ? '•••••••• saved. Type a new value to replace it.' : 'Not set',
      });
    }
    const props = { id, name: setting.name, value: setting.value === undefined ? '' : setting.value, spellcheck: 'false' };
    if (setting.type === 'int') Object.assign(props, { type: 'number', min: setting.min, max: setting.max, step: 1, inputmode: 'numeric' });
    else if (setting.type === 'email') Object.assign(props, { type: 'email', autocomplete: 'off' });
    else Object.assign(props, { type: 'text', maxlength: setting.max, autocomplete: 'off' });
    return el('input', props);
  }

  function renderSettings(list, problems) {
    settingsCache = list;
    renderProblems($('settings-problems'), problems);
    const groups = new Map();
    for (const setting of list) {
      if (!groups.has(setting.group)) groups.set(setting.group, []);
      groups.get(setting.group).push(setting);
    }
    const container = $('settings-groups');
    container.replaceChildren();
    for (const [group, settings] of groups) {
      const card = el('fieldset', { className: 'card settings-group' }, el('legend', {}, el('h2', { text: group })));
      for (const setting of settings) {
        const [sourceText, sourceKind] = SOURCE_LABELS[setting.source] || ['', 'neutral'];
        const meta = el('div', { className: 'setting-meta' }, pill(sourceText, sourceKind));
        if (setting.type === 'secret') meta.append(pill(setting.isSet ? 'Saved' : 'Not set', setting.isSet ? 'ok' : 'warn'));
        if (setting.updatedAt && setting.source === 'portal') meta.append(el('span', { text: `Changed ${formatTime(setting.updatedAt)}${setting.updatedBy ? ` by ${setting.updatedBy}` : ''}` }));
        if (setting.source === 'portal') {
          meta.append(el('button', {
            type: 'button', className: 'button link-like', 'data-reset': setting.name,
            text: 'Undo (use .env/default)', title: 'Remove the value saved here and fall back to the .env file or default.',
          }));
        }
        card.append(el('div', { className: 'setting' },
          el('label', { for: `setting-${setting.name}`, text: setting.label }),
          inputFor(setting),
          setting.help ? el('div', { className: 'small-text', text: setting.help }) : null,
          meta));
      }
      if (group === 'Email') card.append(testButton('Send test email', '/test/email'));
      if (group === 'Instagram') card.append(testButton('Check Instagram connection', '/test/instagram'));
      container.append(card);
    }
  }

  function testButton(label, path) {
    const result = el('span', { role: 'status' });
    const button = el('button', { type: 'button', className: 'button', text: label });
    button.addEventListener('click', withBusy(button, async () => {
      if (settingsChanged().count) {
        setResult(result, 'Save your changes first, then test.', false);
        return;
      }
      setResult(result, 'Testing…', true);
      result.className = 'muted';
      try {
        const data = await api(path, { method: 'POST', body: {} });
        setResult(result, data.message, data.ok);
      } catch (err) {
        setResult(result, err.message, false);
      }
    }));
    return el('div', { className: 'group-actions' }, button, result);
  }

  function settingsChanged() {
    const changes = {};
    let count = 0;
    for (const setting of settingsCache) {
      const input = $(`setting-${setting.name}`);
      if (!input) continue;
      const value = input.value;
      if (setting.type === 'secret') {
        if (value.trim()) {
          changes[setting.name] = value;
          count += 1;
        }
      } else if (String(value) !== String(setting.value === undefined ? '' : setting.value)) {
        changes[setting.name] = value;
        count += 1;
      }
    }
    return { changes, count };
  }

  async function loadSettings() {
    const data = await api('/settings');
    renderSettings(data.settings, data.problems);
    setResult($('settings-result'), '', true);
  }

  async function saveSettings(body, okMessage) {
    const result = $('settings-result');
    try {
      const data = await api('/settings', { method: 'PUT', body });
      renderSettings(data.settings, data.problems);
      setResult(result, data.changed.length ? okMessage : 'Nothing to save.', true);
    } catch (err) {
      setResult(result, err.message, false);
    }
  }

  const settingsForm = $('settings-form');
  const saveButton = settingsForm.querySelector('button[type="submit"]');
  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    withBusy(saveButton, async () => {
      const { changes, count } = settingsChanged();
      if (!count) {
        setResult($('settings-result'), 'Nothing has changed.', true);
        return;
      }
      await saveSettings({ changes }, `Saved ${count} change${count === 1 ? '' : 's'}.`);
    })();
  });

  settingsForm.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reset]');
    if (!button) return;
    const setting = settingsCache.find((s) => s.name === button.dataset.reset);
    if (!setting || !window.confirm(`Remove the "${setting.label}" value saved here and use the .env file or default instead?`)) return;
    withBusy(button, () => saveSettings({ reset: [setting.name] }, `"${setting.label}" now uses the .env file or default.`))();
  });

  // ---------- Page content ----------

  // Same limits as api/lib/content.js. [path, label, max, multiline, help]
  const CONTENT_GROUPS = [
    { title: 'Business and contact details', fields: [
      ['brand.name', 'Business name', 60, false, 'Shown in the header and footer.'],
      ['brand.tagline', 'Footer tagline', 120],
      ['links.email', 'Contact email address', 200, false, 'Shown on the page and in the footer.'],
      ['links.instagramUrl', 'Instagram page link', 200, false, 'For example https://www.instagram.com/frostedharmony/. Leave empty to hide the Instagram links.'],
    ] },
    { title: 'Design: colors, fonts and logo', design: true },
    { title: 'Search engines, browser tab and link previews', fields: [
      ['seo.title', 'Browser tab title', 70, false, 'Also the title Google shows. Keep it under about 60 characters.'],
      ['seo.description', 'Search engine description', 300, false, 'The short summary Google shows under the title.'],
      ['seo.siteUrl', 'Website address', 200, false, 'Used for link previews. Normally https://frostedharmony.com'],
    ], photo: ['seo.shareImage', 'Link preview photo (optional)', 'Shown when someone shares the website on Facebook, iMessage, WhatsApp and similar apps.'] },
    { title: 'Top banner', fields: [
      ['hero.eyebrow', 'Small heading', 120], ['hero.heading', 'Main heading', 120],
      ['hero.lead', 'Text', 600, true], ['hero.primaryButton', 'Main button (goes to the inquiry form)', 40],
      ['hero.secondaryButton', 'Second button (goes to the gallery). Leave empty to hide it.', 40],
    ], photo: ['hero.image', 'Photo (optional)', 'Leave empty to show the cupcake drawing.'] },
    { title: 'Section order', order: true },
    { title: 'Gallery section', id: 'gallery', fields: [
      ['gallery.navLabel', 'Menu label', 30], ['gallery.eyebrow', 'Small heading', 120], ['gallery.heading', 'Heading', 120],
      ['gallery.intro', 'Text', 600, true], ['gallery.followButton', 'Instagram button. Leave empty to hide it.', 40],
    ], gallery: true },
    { title: 'Flavors section', id: 'flavors', fields: [
      ['flavors.navLabel', 'Menu label', 30], ['flavors.eyebrow', 'Small heading', 120], ['flavors.heading', 'Heading', 120],
      ['flavors.intro', 'Text', 600, true],
    ], list: 'flavors' },
    { title: 'Ordering section', id: 'ordering', fields: [
      ['ordering.navLabel', 'Menu label', 30], ['ordering.eyebrow', 'Small heading', 120], ['ordering.heading', 'Heading', 120],
      ['ordering.intro', 'Text', 600, true],
    ], list: 'steps' },
    { title: 'Contact section', fields: [
      ['contact.navLabel', 'Menu button', 30], ['contact.eyebrow', 'Small heading', 120], ['contact.heading', 'Heading', 120],
      ['contact.intro', 'Text', 800, true], ['contact.emailPrompt', 'Text before the email address', 120],
    ] },
  ];
  const SECTION_NAMES = { gallery: 'Gallery', flavors: 'Flavors', ordering: 'Ordering' };
  const LISTS = {
    flavors: { path: 'flavors.items', label: 'Flavor', addLabel: 'Add a flavor', max: 40, blank: { name: '', description: '', price: '' },
      fields: [['name', 'Name', 80], ['price', 'Price (optional), for example "$3 each" or "$36 / dozen"', 40], ['description', 'Description', 400, true]] },
    steps: { path: 'ordering.steps', label: 'Step', addLabel: 'Add a step', max: 10, blank: { title: '', text: '' },
      fields: [['title', 'Title', 80], ['text', 'Text', 400, true]] },
  };

  let contentState = null;
  let contentDirty = false;

  const getAt = (obj, dotted) => dotted.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
  function setAt(obj, dotted, value) {
    const keys = dotted.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], obj)[last] = value;
  }

  function markDirty() {
    contentDirty = true;
    showContentStatus();
  }

  function textField(id, label, value, max, multiline, help, onInput) {
    const input = multiline
      ? el('textarea', { id, rows: 3, spellcheck: 'true' })
      : el('input', { id, type: 'text', spellcheck: 'true', autocomplete: 'off' });
    input.value = value || '';
    const counter = el('div', { className: 'field-counter' });
    const update = () => {
      counter.textContent = `${input.value.length} / ${max}`;
      counter.classList.toggle('over', input.value.length > max);
    };
    update();
    input.addEventListener('input', () => {
      update();
      onInput(input.value);
      markDirty();
    });
    return el('div', { className: 'setting' }, el('label', { for: id, text: label }), input,
      help ? el('div', { className: 'small-text', text: help }) : null, counter);
  }

  function renderOrder() {
    const rows = contentState.order.map((id, index) => {
      const visible = contentState[id].visible;
      const up = el('button', { type: 'button', className: 'button small', text: '↑', title: 'Move up', 'aria-label': `Move ${SECTION_NAMES[id]} up`, disabled: index === 0 });
      const down = el('button', { type: 'button', className: 'button small', text: '↓', title: 'Move down', 'aria-label': `Move ${SECTION_NAMES[id]} down`, disabled: index === contentState.order.length - 1 });
      const box = el('input', { type: 'checkbox', id: `show-${id}` });
      box.checked = visible;
      const move = (delta) => {
        const order = contentState.order;
        [order[index], order[index + delta]] = [order[index + delta], order[index]];
        markDirty();
        renderContentForm();
      };
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      box.addEventListener('change', () => {
        contentState[id].visible = box.checked;
        markDirty();
      });
      return el('div', { className: 'order-row' }, el('span', { className: 'order-name', text: `${index + 1}. ${SECTION_NAMES[id]}` }),
        el('label', { for: `show-${id}` }, box, 'Show on the site'), up, down);
    });
    return el('div', {}, el('p', { className: 'small-text', text: 'The top banner always comes first and the contact form always comes last.' }), ...rows);
  }

  function renderList(kind) {
    const spec = LISTS[kind];
    const items = getAt(contentState, spec.path);
    const wrap = el('div', {}, el('h3', { text: kind === 'flavors' ? 'Flavors' : 'Steps' }));
    items.forEach((item, index) => {
      const tools = el('div', { className: 'item-tools' });
      const button = (label, title, disabled, action) => {
        const b = el('button', { type: 'button', className: 'button', text: label, title, 'aria-label': title, disabled });
        b.addEventListener('click', action);
        tools.append(b);
      };
      const rerender = () => {
        markDirty();
        renderContentForm();
      };
      button('↑', `Move ${spec.label.toLowerCase()} ${index + 1} up`, index === 0, () => {
        [items[index - 1], items[index]] = [items[index], items[index - 1]];
        rerender();
      });
      button('↓', `Move ${spec.label.toLowerCase()} ${index + 1} down`, index === items.length - 1, () => {
        [items[index + 1], items[index]] = [items[index], items[index + 1]];
        rerender();
      });
      button('Remove', `Remove ${spec.label.toLowerCase()} ${index + 1}`, false, () => {
        const name = item.name || item.title || `${spec.label} ${index + 1}`;
        if (!window.confirm(`Remove "${name}"? (Nothing changes on the website until you publish.)`)) return;
        items.splice(index, 1);
        rerender();
      });
      const box = el('div', { className: 'list-item' },
        el('div', { className: 'list-item-head' }, el('strong', { text: `${spec.label} ${index + 1}` }), tools));
      const fieldEls = spec.fields.map(([key, label, max, multiline]) => textField(`${kind}-${index}-${key}`, label, item[key], max, multiline, null, (v) => {
        item[key] = v;
      }));
      if (kind === 'flavors') {
        box.append(el('div', { className: 'two-fields' }, fieldEls[0], fieldEls[1]), fieldEls[2],
          photoPicker(`flavors-${index}-image`, 'Photo (optional)', item.image, null, (id) => {
            item.image = id;
          }));
      }
      else box.append(...fieldEls);
      wrap.append(box);
    });
    const add = el('button', { type: 'button', className: 'button', text: spec.addLabel, disabled: items.length >= spec.max });
    add.addEventListener('click', () => {
      items.push({ ...spec.blank });
      markDirty();
      renderContentForm();
      const first = document.getElementById(`${kind}-${items.length - 1}-${spec.fields[0][0]}`);
      if (first) first.focus();
    });
    wrap.append(add);
    return wrap;
  }

  function renderContentForm() {
    const form = $('content-form');
    const scroll = window.scrollY;
    form.replaceChildren();
    for (const group of CONTENT_GROUPS) {
      const card = el('fieldset', { className: 'card settings-group' }, el('legend', {}, el('h2', { text: group.title })));
      if (group.id && !contentState[group.id].visible) {
        card.append(el('p', { className: 'notice', text: 'This section is hidden on the site. Turn it on under "Section order".' }));
      }
      if (group.order) card.append(renderOrder());
      for (const [field, label, max, multiline, help] of group.fields || []) {
        card.append(textField(`content-${field.replace('.', '-')}`, label, getAt(contentState, field), max, multiline, help, (v) => setAt(contentState, field, v)));
      }
      if (group.list) card.append(renderList(group.list));
      if (group.photo) {
        const [field, label, help] = group.photo;
        card.append(photoPicker(`content-${field.replace('.', '-')}`, label, getAt(contentState, field), help, (id) => setAt(contentState, field, id)));
      }
      if (group.gallery) card.append(renderGalleryPhotos());
      if (group.design) card.append(renderDesign());
      form.append(card);
    }
    window.scrollTo(0, scroll);
  }

  let contentMeta = null;

  function showContentStatus() {
    if (!contentMeta) return;
    const live = $('content-live');
    live.replaceChildren(
      contentMeta.published
        ? el('span', { text: `Live site: published ${formatTime(contentMeta.published.at)}${contentMeta.published.by ? ` by ${contentMeta.published.by}` : ''}` })
        : el('span', { text: 'Live site: the original version (nothing published from here yet)' }),
    );
    let draftText = 'Everything is published.';
    let kind = 'ok';
    if (contentDirty) {
      draftText = 'You have unsaved edits.';
      kind = 'warn';
    } else if (contentMeta.hasUnpublishedChanges) {
      draftText = `Draft saved ${formatTime(contentMeta.savedAt)}${contentMeta.savedBy ? ` by ${contentMeta.savedBy}` : ''}, not published yet.`;
      kind = 'warn';
    }
    $('content-draft').replaceChildren(pill(kind === 'ok' ? 'Up to date' : 'Not published', kind), ' ', draftText);
    $('content-discard').hidden = !contentMeta.hasUnpublishedChanges && !contentDirty;
  }

  function renderHistory(entries) {
    const list = $('content-history');
    if (!entries.length) {
      list.replaceChildren(el('li', { className: 'muted', text: 'Nothing has been published from the portal yet.' }));
      return;
    }
    list.replaceChildren(...entries.map((entry) => {
      const title = entry.label === 'original' ? 'Original website' : `Published ${formatTime(entry.at)}${entry.by ? ` by ${entry.by}` : ''}`;
      const edit = el('button', { type: 'button', className: 'button small', text: 'Edit' });
      const goLive = el('button', { type: 'button', className: 'button small', text: 'Put back live', hidden: entry.live });
      edit.addEventListener('click', withBusy(edit, () => restoreVersion(entry, false, title)));
      goLive.addEventListener('click', withBusy(goLive, () => restoreVersion(entry, true, title)));
      return el('li', { className: 'order-row' }, el('span', { className: 'order-name', text: title }),
        entry.live ? pill('Live now', 'ok') : null, edit, goLive);
    }));
  }

  // keepLocalEdits: refresh the status and history but leave the editor (and unsaved typing) alone.
  // The editor keeps the revision its content is based on, so a later save still detects a draft
  // that someone else saved in the meantime.
  function applyContentResponse(data, { keepLocalEdits = false } = {}) {
    contentMeta = keepLocalEdits
      ? { ...data, revision: contentMeta.revision, savedAt: contentMeta.savedAt, savedBy: contentMeta.savedBy }
      : data;
    if (!keepLocalEdits) {
      contentState = data.draft;
      contentDirty = false;
      renderContentForm();
    }
    renderHistory(data.history);
    showContentStatus();
  }

  async function loadContent() {
    if (contentDirty && !window.confirm('Discard your unsaved edits and reload the page content?')) return;
    const [data, library] = await Promise.all([api('/content'), api('/media')]);
    photosCache = library.photos;
    applyContentResponse(data);
    setResult($('content-result'), '', true);
  }

  async function saveContent({ quiet = false } = {}) {
    const data = await api('/content', { method: 'PUT', body: { content: contentState, revision: contentMeta.revision } });
    applyContentResponse(data);
    if (!quiet) setResult($('content-result'), 'Draft saved. Use Preview to check it, then Publish.', true);
  }

  async function contentAction(task) {
    const result = $('content-result');
    try {
      await task();
    } catch (err) {
      if (err.status !== 401) setResult(result, err.message, false);
    }
  }

  async function restoreVersion(entry, publish, title) {
    const question = publish
      ? `Put "${title}" back on the live website now? Your draft (including any unsaved edits on this page) is kept as it is.`
      : `Copy "${title}" into your draft? ${contentDirty || contentMeta.hasUnpublishedChanges ? 'Your current unpublished edits will be replaced. ' : ''}The live site won't change until you publish.`;
    if (!window.confirm(question)) return;
    await contentAction(async () => {
      const data = await api('/content/restore', { method: 'POST', body: { id: entry.id, publish, revision: contentMeta.revision } });
      applyContentResponse(data, { keepLocalEdits: publish && contentDirty });
      setResult($('content-result'), publish ? 'Done. That version is live now.' : 'Copied into your draft. Preview it, then publish when ready.', true);
    });
  }

  $('content-save').addEventListener('click', withBusy($('content-save'), () => contentAction(() => saveContent())));

  $('content-preview').addEventListener('click', withBusy($('content-preview'), () => contentAction(async () => {
    // Open the tab first (browsers block pop-ups opened after a delay), then save and load it.
    const tab = window.open('', '_blank');
    try {
      if (contentDirty) await saveContent({ quiet: true });
      if (tab) tab.location.href = `/api/admin/content/preview?t=${Date.now()}`;
      setResult($('content-result'), 'Preview opened in a new tab.', true);
    } catch (err) {
      if (tab) tab.close();
      throw err;
    }
  })));

  $('content-publish').addEventListener('click', withBusy($('content-publish'), () => contentAction(async () => {
    if (!contentDirty && !contentMeta.hasUnpublishedChanges) {
      setResult($('content-result'), 'There are no changes to publish.', true);
      return;
    }
    if (!window.confirm('Publish these changes to the live website now?')) return;
    if (contentDirty) await saveContent({ quiet: true });
    applyContentResponse(await api('/content/publish', { method: 'POST', body: { revision: contentMeta.revision } }));
    setResult($('content-result'), 'Published! The website now shows your changes.', true);
  })));

  $('content-discard').addEventListener('click', withBusy($('content-discard'), () => contentAction(async () => {
    if (!window.confirm('Throw away all unpublished changes and go back to what is live now?')) return;
    applyContentResponse(await api('/content/discard', { method: 'POST', body: {} }));
    setResult($('content-result'), 'Draft discarded. It matches the live site again.', true);
  })));

  window.addEventListener('beforeunload', (event) => {
    if (!contentDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // ---------- Photos ----------

  let photosCache = [];
  const photoById = (id) => photosCache.find((p) => p.id === id);
  const photoLabel = (photo) => (photo && photo.alt ? photo.alt : 'Photo without a description');

  function photoThumb(photo, className) {
    return el('img', { src: photo.thumb, alt: photo.alt || '', className, loading: 'lazy', decoding: 'async' });
  }

  function noPhotosHint() {
    return el('p', { className: 'small-text' }, 'No photos uploaded yet. Add some on the ', el('a', { href: '#photos', className: 'link', text: 'Photos tab' }), '.');
  }

  // Choose one photo (or none). onChange receives the photo id or ''.
  function photoPicker(id, label, currentId, help, onChange) {
    const wrap = el('div', { className: 'setting' });
    let current = currentId || '';
    let open = false;
    const render = () => {
      const photo = current ? photoById(current) : null;
      const choose = el('button', { type: 'button', className: 'button small', id, text: photo ? 'Change photo' : 'Choose a photo', 'aria-expanded': String(open) });
      choose.addEventListener('click', () => {
        open = !open;
        render();
      });
      const remove = el('button', { type: 'button', className: 'button small link-like', text: 'Remove photo', hidden: !current });
      remove.addEventListener('click', () => {
        current = '';
        open = false;
        onChange('');
        markDirty();
        render();
      });
      const preview = photo ? photoThumb(photo) : el('div', { className: 'picker-empty', text: current ? 'Photo missing' : 'No photo' });
      const picker = el('div', { className: 'picker' },
        el('div', { className: 'picker-current' }, preview,
          el('div', {}, el('div', { className: 'small-text', text: photo ? photoLabel(photo) : '' }), choose, ' ', remove)));
      if (open) {
        if (!photosCache.length) picker.append(noPhotosHint());
        else {
          picker.append(el('div', { className: 'picker-library', role: 'group', 'aria-label': `Choose: ${label}` },
            photosCache.map((p) => {
              const option = el('button', { type: 'button', title: photoLabel(p), 'aria-label': photoLabel(p), 'aria-pressed': String(p.id === current) }, photoThumb(p));
              option.addEventListener('click', () => {
                current = p.id;
                open = false;
                onChange(p.id);
                markDirty();
                render();
                const again = document.getElementById(id);
                if (again) again.focus();
              });
              return option;
            })));
        }
      }
      wrap.replaceChildren(el('label', { for: id, text: label }), picker, help ? el('div', { className: 'small-text', text: help }) : null);
    };
    render();
    return wrap;
  }

  const GALLERY_SOURCE_OPTIONS = [
    ['mixed', 'My photos first, then the latest Instagram posts'],
    ['photos', 'Only my photos'],
    ['instagram', 'Only Instagram posts'],
  ];

  function renderGalleryPhotos() {
    const gallery = contentState.gallery;
    const wrap = el('div', {});
    let open = false;
    const render = () => {
      const radios = GALLERY_SOURCE_OPTIONS.map(([value, text]) => {
        const radio = el('input', { type: 'radio', name: 'gallery-source', value, id: `gallery-source-${value}` });
        radio.checked = gallery.source === value;
        radio.addEventListener('change', () => {
          gallery.source = value;
          markDirty();
          render();
        });
        return el('label', { for: `gallery-source-${value}` }, radio, text);
      });
      const tiles = gallery.photos.map((id, index) => {
        const photo = photoById(id);
        const tools = el('div', { className: 'item-tools' });
        const button = (text, title, disabled, action) => {
          const b = el('button', { type: 'button', className: 'button', text, title, 'aria-label': title, disabled });
          b.addEventListener('click', () => {
            action();
            markDirty();
            render();
          });
          tools.append(b);
        };
        button('←', `Move gallery photo ${index + 1} earlier`, index === 0, () => {
          [gallery.photos[index - 1], gallery.photos[index]] = [gallery.photos[index], gallery.photos[index - 1]];
        });
        button('→', `Move gallery photo ${index + 1} later`, index === gallery.photos.length - 1, () => {
          [gallery.photos[index + 1], gallery.photos[index]] = [gallery.photos[index], gallery.photos[index + 1]];
        });
        button('✕', `Remove gallery photo ${index + 1}`, false, () => gallery.photos.splice(index, 1));
        return el('div', { className: 'gallery-tile' }, photo ? photoThumb(photo) : el('div', { className: 'picker-empty', text: 'Photo missing' }), tools);
      });
      const add = el('button', { type: 'button', className: 'button', text: open ? 'Done adding' : 'Add photos to the gallery', 'aria-expanded': String(open) });
      add.addEventListener('click', () => {
        open = !open;
        render();
      });
      const parts = [
        el('h3', { text: 'What the gallery shows' }), el('div', { className: 'radio-row' }, radios),
        el('h3', { text: `My gallery photos (${gallery.photos.length})` }),
      ];
      if (gallery.source === 'instagram') parts.push(el('p', { className: 'small-text', text: 'Your own photos are not shown while "Only Instagram posts" is selected.' }));
      parts.push(tiles.length ? el('div', { className: 'gallery-list' }, tiles) : el('p', { className: 'small-text', text: 'No photos chosen yet.' }), add);
      if (open) {
        if (!photosCache.length) parts.push(noPhotosHint());
        else {
          parts.push(el('p', { className: 'small-text', text: 'Click photos to add or remove them. They are added at the end; use the arrows to reorder.' }),
            el('div', { className: 'picker-library', role: 'group', 'aria-label': 'Add photos to the gallery' }, photosCache.map((p) => {
              const inGallery = gallery.photos.includes(p.id);
              const option = el('button', { type: 'button', title: photoLabel(p), 'aria-label': photoLabel(p), 'aria-pressed': String(inGallery) }, photoThumb(p));
              option.addEventListener('click', () => {
                if (inGallery) gallery.photos.splice(gallery.photos.indexOf(p.id), 1);
                else gallery.photos.push(p.id);
                markDirty();
                render();
              });
              return option;
            })));
        }
      }
      wrap.replaceChildren(...parts);
    };
    render();
    return wrap;
  }

  // Photos tab

  const MAX_UPLOAD = 20 * 1024 * 1024;

  async function loadPhotos(highlight) {
    const data = await api('/media');
    photosCache = data.photos;
    renderPhotoGrid(highlight);
  }

  function formatBytes(bytes) {
    return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function renderPhotoGrid(highlight = []) {
    const grid = $('photo-grid');
    // Keep descriptions typed but not saved yet, so a finished upload or a delete doesn't erase them.
    const unsaved = new Map();
    for (const area of grid.querySelectorAll('textarea[data-photo]')) {
      const saved = (photoById(area.dataset.photo) || {}).alt || '';
      if (area.value.trim() !== saved) unsaved.set(area.dataset.photo, area.value);
    }
    const focused = document.activeElement && grid.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA'
      ? { id: document.activeElement.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
    if (!photosCache.length) {
      grid.replaceChildren(el('p', { className: 'muted', text: 'No photos yet. Upload some above.' }));
      return;
    }
    renderPhotoCards(grid, highlight, unsaved);
    if (focused) {
      const again = document.getElementById(focused.id);
      if (again) {
        again.focus();
        again.setSelectionRange(focused.start, focused.end);
      }
    }
  }

  function renderPhotoCards(grid, highlight, unsaved) {
    grid.replaceChildren(...photosCache.map((photo) => {
      const inputId = `alt-${photo.id}`;
      const alt = el('textarea', { id: inputId, rows: 2, maxlength: 250, 'data-photo': photo.id, placeholder: 'For example: Three red velvet cupcakes with pink frosting' });
      alt.value = unsaved.has(photo.id) ? unsaved.get(photo.id) : photo.alt || '';
      const save = el('button', { type: 'button', className: 'button small', text: 'Save description', disabled: !unsaved.has(photo.id) });
      const result = el('span', { className: 'small-text', role: 'status' });
      alt.addEventListener('input', () => {
        save.disabled = alt.value.trim() === (photo.alt || '');
      });
      save.addEventListener('click', withBusy(save, async () => {
        try {
          const data = await api(`/media/${photo.id}`, { method: 'PUT', body: { alt: alt.value } });
          Object.assign(photo, data.photo);
          setResult(result, 'Saved.', true);
          save.disabled = true;
          card.classList.remove('highlight');
          needs.hidden = Boolean(photo.alt);
        } catch (err) {
          if (err.status !== 401) setResult(result, err.message, false);
        }
      }));
      const used = photo.usedIn || [];
      const remove = el('button', {
        type: 'button', className: 'button small link-like', text: 'Delete',
        disabled: used.length > 0, title: used.length ? 'Remove it from the page first (Page content tab).' : 'Delete this photo',
      });
      remove.addEventListener('click', withBusy(remove, async () => {
        if (!window.confirm('Delete this photo permanently?')) return;
        try {
          await api(`/media/${photo.id}`, { method: 'DELETE' });
          photosCache = photosCache.filter((p) => p.id !== photo.id);
          renderPhotoGrid();
          setResult($('photos-result'), 'Photo deleted.', true);
        } catch (err) {
          if (err.status !== 401) setResult(result, err.message, false);
        }
      }));
      const needs = el('span', { className: 'pill warn', text: 'Needs a description', hidden: Boolean(photo.alt) });
      const card = el('div', { className: `card photo-card${highlight.includes(photo.id) ? ' highlight' : ''}` },
        photoThumb(photo),
        el('div', { className: 'photo-body' },
          el('label', { for: inputId }, 'Description ', el('span', { className: 'muted', text: '(what is in the photo)' })),
          alt,
          el('div', { className: 'chips' }, needs, ...(used.length ? used.map((u) => pill(u, 'ok')) : [pill('Not used on the website', 'neutral')])),
          el('div', { className: 'small-text', text: `${photo.width} × ${photo.height} · ${formatBytes(photo.bytes)} · added ${formatTime(photo.createdAt)}${photo.createdBy ? ` by ${photo.createdBy}` : ''}` }),
          el('div', { className: 'photo-actions' }, el('span', {}, save, ' ', result), remove)));
      return card;
    }));
  }

  async function uploadOne(file) {
    if (file.size > MAX_UPLOAD) throw new Error('Too big: photos can be at most 20 MB.');
    let res;
    try {
      res = await fetch('/api/admin/media', {
        method: 'POST', credentials: 'same-origin', body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': csrf, Accept: 'application/json' },
        signal: AbortSignal.timeout(180000),
      });
    } catch {
      throw new Error('Upload failed. Check your connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showLogin('Your session ended. Please sign in again.');
      throw new Error('Please sign in.');
    }
    if (!res.ok || !data.ok) throw new Error(data.error || `Upload failed (${res.status}).`);
    return data.photo;
  }

  async function uploadFiles(files) {
    const list = $('upload-progress');
    const added = [];
    for (const file of files) {
      const status = el('span', { className: 'muted', text: 'Uploading…' });
      list.prepend(el('li', {}, el('strong', { text: file.name || 'Photo' }), ' ', status));
      try {
        const photo = await uploadOne(file);
        added.push(photo.id);
        photosCache.unshift(photo);
        renderPhotoGrid(added);
        status.textContent = 'Done. Add a description below.';
        status.className = 'result-ok';
      } catch (err) {
        status.textContent = err.message;
        status.className = 'result-bad';
        if (/sign in/i.test(err.message)) return;
      }
    }
    if (added.length) {
      // Only move the cursor if the user isn't already typing a description somewhere.
      const typing = document.activeElement && $('photo-grid').contains(document.activeElement);
      const first = document.getElementById(`alt-${added[0]}`);
      if (first && !typing) first.focus();
    }
  }

  const photoInput = $('photo-input');
  photoInput.addEventListener('change', () => {
    const files = [...photoInput.files];
    photoInput.value = '';
    if (files.length) uploadFiles(files);
  });
  const zone = $('upload-zone');
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dragging');
    const files = [...(event.dataTransfer ? event.dataTransfer.files : [])];
    if (files.length) uploadFiles(files);
  });

  // ---------- Design ----------

  // Same rules as api/lib/theme.js (WCAG contrast): text needs 4.5:1, buttons at least 3:1.
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }
  const onPrimary = (c) => (contrast('#ffffff', c.primary) >= contrast(c.text, c.primary) ? '#ffffff' : c.text);
  function contrastChecks(c) {
    const btn = onPrimary(c);
    const text = [
      ['Main text on the page background', c.text, c.background], ['Main text on cards', c.text, c.surface],
      ['Secondary text on the page background', c.textSoft, c.background], ['Secondary text on cards', c.textSoft, c.surface],
      ['Secondary text on tinted sections', c.textSoft, c.tint], ['Accent text on the page background', c.primaryDark, c.background],
      ['Accent text on tinted sections', c.primaryDark, c.tint], ['Accent text on cards', c.primaryDark, c.surface],
      ['Footer text', c.background, c.text], ['Footer links', c.accentSoft, c.text],
    ].map(([label, fg, bg]) => ({ label, ratio: contrast(fg, bg), min: 4.5 }));
    const buttons = [
      ['Button text', btn, c.primary], ['Button text when hovered', btn === '#ffffff' ? '#ffffff' : c.text, c.primaryDark],
      ['Outline button on the page background', c.primary, c.background],
    ].map(([label, fg, bg]) => ({ label, ratio: contrast(fg, bg), min: 3, recommended: 4.5 }));
    return [...text, ...buttons];
  }
  const HEX = /^#[0-9a-f]{6}$/;

  function renderDesign() {
    const t = contentState.theme;
    const options = contentMeta.design;
    const wrap = el('div', {});
    const sample = el('div', { className: 'design-sample' });
    const report = el('div', { className: 'contrast-report', role: 'status', 'aria-live': 'polite' });

    const fontStack = (list, key) => (list.find((f) => f.key === key) || list[0]).stack;
    function paintSample() {
      const c = t.colors;
      const set = (name, value) => sample.style.setProperty(name, value);
      set('--s-bg', c.background); set('--s-surface', c.surface); set('--s-tint', c.tint); set('--s-soft', c.accentSoft);
      set('--s-primary', c.primary); set('--s-dark', c.primaryDark); set('--s-text', c.text); set('--s-text-soft', c.textSoft);
      set('--s-on-primary', onPrimary(c));
      set('--s-heading', fontStack(options.headingFonts, t.headingFont));
      set('--s-heading-weight', String((options.headingFonts.find((f) => f.key === t.headingFont) || {}).weight || 700));
      set('--s-body', fontStack(options.bodyFonts, t.bodyFont));
      set('--s-radius', (options.corners.find((x) => x.key === t.corners) || {}).value || '16px');
      set('--s-button-radius', (options.buttons.find((x) => x.key === t.buttons) || {}).value || '999px');
    }
    sample.append(
      el('p', { className: 'design-sample-eyebrow', text: 'Handcrafted cupcakes' }),
      el('p', { className: 'design-sample-heading', text: 'Sweet moments' }),
      el('p', { className: 'design-sample-text', text: 'Baked from scratch and decorated by hand.' }),
      el('div', { className: 'design-sample-card' }, el('strong', { text: 'Red Velvet' }), el('span', { text: 'Tangy cream cheese frosting.' })),
      el('div', { className: 'design-sample-buttons' }, el('span', { className: 'design-sample-button', text: 'Request pricing' }),
        el('span', { className: 'design-sample-button outline', text: 'See our cupcakes' })),
      el('div', { className: 'design-sample-footer', text: '© Frosted Harmony · ' }, el('span', { text: 'Instagram' })),
    );

    function updateReport() {
      const valid = Object.values(t.colors).every((v) => HEX.test(v));
      if (!valid) {
        report.replaceChildren(el('p', { className: 'result-bad', text: 'Some colors are not valid yet.' }));
        return;
      }
      const checks = contrastChecks(t.colors);
      const failing = checks.filter((c) => c.ratio < c.min);
      const warn = checks.filter((c) => c.ratio >= c.min && c.recommended && c.ratio < c.recommended);
      const summary = failing.length
        ? el('p', { className: 'result-bad', text: `${failing.length} combination${failing.length === 1 ? ' is' : 's are'} too hard to read. Saving is blocked until fixed.` })
        : warn.length
          ? el('p', { className: 'notice', text: 'Readable. The buttons pass the minimum, but a little more contrast would help people with low vision.' })
          : el('p', { className: 'result-ok', text: 'All text is easy to read (meets the WCAG AA accessibility standard).' });
      const details = el('details', {}, el('summary', { text: 'Show every combination' }), el('ul', { className: 'plain-list' }, checks.map((c) => {
        const kind = c.ratio < c.min ? 'bad' : c.recommended && c.ratio < c.recommended ? 'warn' : 'ok';
        return el('li', {}, pill(`${c.ratio.toFixed(2)}:1`, kind), ' ', c.label, el('span', { className: 'small-text', text: ` (needs ${c.min}:1${c.recommended ? `, ideally ${c.recommended}:1` : ''})` }));
      })));
      if (failing.length) details.open = true;
      report.replaceChildren(summary, details);
    }

    const changed = () => {
      markDirty();
      paintSample();
      updateReport();
    };

    const presetButtons = options.presets.map((preset) => {
      const swatches = el('span', { className: 'swatches', 'aria-hidden': 'true' },
        ['background', 'tint', 'primary', 'text'].map((k) => {
          const dot = el('span', { className: 'swatch' });
          dot.style.setProperty('background', preset.colors[k]);
          return dot;
        }));
      const button = el('button', { type: 'button', className: 'button small preset' }, swatches, preset.label);
      button.addEventListener('click', () => {
        Object.assign(t.colors, preset.colors);
        renderContentForm();
        markDirty();
      });
      return button;
    });

    const colorRows = options.colors.map(({ key, label }) => {
      const picker = el('input', { type: 'color', id: `color-${key}`, 'aria-label': label });
      picker.value = t.colors[key];
      const hex = el('input', { type: 'text', className: 'hex-input', maxlength: 7, spellcheck: 'false', 'aria-label': `${label} (hex code)` });
      hex.value = t.colors[key];
      picker.addEventListener('input', () => {
        t.colors[key] = picker.value.toLowerCase();
        hex.value = t.colors[key];
        hex.removeAttribute('aria-invalid');
        changed();
      });
      hex.addEventListener('input', () => {
        const value = hex.value.trim().toLowerCase();
        const normalized = /^[0-9a-f]{6}$/.test(value) ? `#${value}` : value;
        t.colors[key] = normalized;
        if (HEX.test(normalized)) {
          picker.value = normalized;
          hex.removeAttribute('aria-invalid');
        } else hex.setAttribute('aria-invalid', 'true');
        changed();
      });
      return el('div', { className: 'color-row' }, picker, hex, el('label', { for: `color-${key}`, text: label }));
    });

    const select = (id, label, list, current, onPick, describe) => {
      const box = el('select', { id });
      for (const item of list) {
        const option = el('option', { value: item.key, text: describe ? describe(item) : item.label });
        option.selected = item.key === current;
        box.append(option);
      }
      box.addEventListener('change', () => {
        onPick(box.value);
        changed();
      });
      return el('div', { className: 'setting' }, el('label', { for: id, text: label }), box);
    };
    const shapeName = { subtle: 'Subtle', soft: 'Soft (original)', round: 'Round', square: 'Square', pill: 'Pill (original)', rounded: 'Rounded' };

    wrap.append(
      el('h3', { text: 'Colors' }),
      el('p', { className: 'small-text', text: 'Start from a ready-made palette, then adjust any color.' }),
      el('div', { className: 'preset-row' }, presetButtons),
      el('div', { className: 'design-layout' },
        el('div', {}, el('div', { className: 'color-grid' }, colorRows), report),
        el('div', {}, el('div', { className: 'small-text', text: 'Live sample' }), sample)),
      el('h3', { text: 'Fonts and shapes' }),
      el('div', { className: 'two-fields' },
        select('design-heading-font', 'Headings', options.headingFonts, t.headingFont, (v) => { t.headingFont = v; }),
        select('design-body-font', 'Text', options.bodyFonts, t.bodyFont, (v) => { t.bodyFont = v; })),
      el('div', { className: 'two-fields' },
        select('design-buttons', 'Buttons', options.buttons, t.buttons, (v) => { t.buttons = v; }, (x) => shapeName[x.key] || x.key),
        select('design-corners', 'Corners of cards and photos', options.corners, t.corners, (v) => { t.corners = v; }, (x) => shapeName[x.key] || x.key)),
      el('h3', { text: 'Logo' }),
      photoPicker('content-theme-logo', 'Logo (optional)', t.logo, 'Shown in the top-left corner. Also used for the browser-tab and phone home-screen icons. A square image or one with a transparent background (PNG) works best.', (id) => {
        t.logo = id;
      }),
    );
    paintSample();
    updateReport();
    return wrap;
  }

  // ---------- Account ----------

  async function loadAccount() {
    const data = await api('/sessions');
    $('sessions').replaceChildren(...data.sessions.map((s) => el('li', {},
      el('strong', { text: s.current ? 'This browser' : describeAgent(s.userAgent) }),
      el('div', { className: 'small-text', text: `Signed in ${formatTime(s.createdAt)} · last active ${formatTime(s.lastSeen)} · ${s.ip}` }))));
    $('revoke-others').hidden = data.sessions.length < 2;
  }

  function describeAgent(agent) {
    if (!agent) return 'Unknown device';
    const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
    const system = /iPhone|iPad/.test(agent) ? 'iPhone/iPad' : /Android/.test(agent) ? 'Android' : /Windows/.test(agent) ? 'Windows' : /Mac OS/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : '';
    return system ? `${browser} on ${system}` : browser;
  }

  const revokeButton = $('revoke-others');
  revokeButton.addEventListener('click', withBusy(revokeButton, async () => {
    try {
      const data = await api('/sessions/revoke-others', { method: 'POST', body: {} });
      setResult($('sessions-result'), `Signed out ${data.signedOut} other device${data.signedOut === 1 ? '' : 's'}.`, true);
      await loadAccount();
    } catch (err) {
      setResult($('sessions-result'), err.message, false);
    }
  }));

  const passwordForm = $('password-form');
  const passwordButton = passwordForm.querySelector('button[type="submit"]');
  passwordForm.addEventListener('submit', (event) => {
    event.preventDefault();
    withBusy(passwordButton, async () => {
      const result = $('password-result');
      const currentPassword = $('current-password').value;
      const newPassword = $('new-password').value;
      if (newPassword.length < 12) return setResult(result, 'The new password must be at least 12 characters.', false);
      if (newPassword !== $('confirm-password').value) return setResult(result, 'The new passwords do not match.', false);
      try {
        const data = await api('/password', { method: 'POST', body: { currentPassword, newPassword } });
        passwordForm.reset();
        $('password-username').value = currentUser.username;
        setResult(result, `Password changed.${data.signedOut ? ` ${data.signedOut} other device${data.signedOut === 1 ? ' was' : 's were'} signed out.` : ''}`, true);
        await loadAccount();
      } catch (err) {
        setResult(result, err.message, false);
      }
      return undefined;
    })();
  });

  // ---------- Start ----------

  async function startUp() {
    try {
      const status = await api('/status');
      if (!status.ready) {
        $('setup-message').textContent = !status.keyConfigured
          ? 'The server needs an ADMIN_ENCRYPTION_KEY in its .env file before the portal can be used.'
          : 'No admin account exists yet. Create one on the server with the create-admin command.';
        show('view-setup');
        return;
      }
    } catch (err) {
      $('setup-message').textContent = err.message;
      show('view-setup');
      return;
    }
    try {
      const me = await fetch('/api/admin/me', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (me.ok) {
        const data = await me.json();
        csrf = data.csrf;
        currentUser = data.user;
        enterApp();
        return;
      }
    } catch {
      // Fall through to sign-in.
    }
    showLogin();
  }

  startUp();
})();
