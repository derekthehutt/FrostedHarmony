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

  const PAGES = { dashboard: loadDashboard, settings: loadSettings, account: loadAccount };

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
