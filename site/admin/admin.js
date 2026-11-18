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
    $('code-form').hidden = true;
    $('login-form').hidden = false;
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
        $('login-password').value = '';
        if (data.needsCode) {
          showCodeStep(data.ticket);
          return;
        }
        csrf = data.csrf;
        currentUser = data.user;
        enterApp();
      } catch (err) {
        $('login-error').textContent = err.message;
        $('login-password').select();
      } finally {
        loginButton.textContent = 'Sign in';
      }
    })();
  });

  // Second step when two-step sign-in is on.
  let loginTicket = null;
  const codeForm = $('code-form');
  const codeButton = codeForm.querySelector('button[type="submit"]');

  function showCodeStep(ticket) {
    loginTicket = ticket;
    loginForm.hidden = true;
    codeForm.hidden = false;
    $('code-error').textContent = '';
    $('login-code').value = '';
    $('login-code').focus();
  }

  function backToPassword(message) {
    loginTicket = null;
    codeForm.hidden = true;
    loginForm.hidden = false;
    $('login-error').textContent = message || '';
    $('login-password').focus();
  }

  codeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    withBusy(codeButton, async () => {
      const code = $('login-code').value.trim();
      if (!code) {
        $('code-error').textContent = 'Type the code from your authenticator app.';
        return;
      }
      try {
        const res = await fetch('/api/admin/login/code', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ ticket: loginTicket, code }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          if (data.restart) backToPassword(data.error || 'Please sign in again.');
          else {
            $('code-error').textContent = data.error || 'Sign-in failed.';
            $('login-code').select();
          }
          return;
        }
        loginTicket = null;
        csrf = data.csrf;
        currentUser = data.user;
        codeForm.hidden = true;
        loginForm.hidden = false;
        enterApp();
        if (data.notice) showGlobal(data.notice, false);
      } catch {
        $('code-error').textContent = 'Could not reach the server. Check your connection and try again.';
      }
    })();
  });
  $('code-cancel').addEventListener('click', () => backToPassword());

  // Asks for the signed-in admin's password before a sensitive change. Resolves to the password,
  // or null when cancelled.
  function askPassword(message) {
    const dialog = $('password-dialog');
    const input = $('password-dialog-input');
    $('password-dialog-text').textContent = message;
    $('password-dialog-username').value = currentUser ? currentUser.username : '';
    input.value = '';
    return new Promise((resolve) => {
      const done = (value) => {
        dialog.removeEventListener('close', onClose);
        $('password-dialog-form').removeEventListener('submit', onSubmit);
        $('password-dialog-cancel').removeEventListener('click', onCancel);
        if (dialog.open) dialog.close();
        input.value = '';
        resolve(value);
      };
      const onSubmit = (event) => {
        event.preventDefault();
        if (!input.value) {
          input.focus();
          return;
        }
        done(input.value);
      };
      const onCancel = () => done(null);
      const onClose = () => done(null);
      $('password-dialog-form').addEventListener('submit', onSubmit);
      $('password-dialog-cancel').addEventListener('click', onCancel);
      dialog.addEventListener('close', onClose);
      dialog.showModal();
      input.focus();
    });
  }

  $('logout-button').addEventListener('click', async () => {
    try {
      await api('/logout', { method: 'POST', body: {} });
    } catch {
      // Signed out locally either way.
    }
    showLogin('You have signed out.');
  });

  // ---------- Navigation ----------

  const PAGES = { dashboard: loadDashboard, inbox: loadInbox, content: loadContent, photos: loadPhotos, settings: loadSettings, admins: loadAdmins, backup: loadBackup, account: loadAccount };
  const OWNER_PAGES = ['settings', 'admins', 'backup'];
  const isOwner = () => Boolean(currentUser) && currentUser.role === 'owner';

  function currentPage() {
    const name = location.hash.replace('#', '');
    if (OWNER_PAGES.includes(name) && !isOwner()) return 'dashboard';
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
    // The page editor uses the full width for the editor and its preview side by side.
    document.body.classList.toggle('wide-page', page === 'content');
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
    $('who-name').textContent = `${currentUser.username}${isOwner() ? '' : ' (editor)'}`;
    $('password-username').value = currentUser.username;
    for (const link of document.querySelectorAll('[data-owner-only]')) link.hidden = !isOwner();
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
      isOwner() ? el('a', { href: '#settings', className: 'link', text: 'Email settings' }) : null,
    ]);

    let igPill = pill('Not connected', 'warn');
    if (instagram.configured) igPill = instagram.lastError ? pill('Problem', 'bad') : pill('Connected', 'ok');
    const kindText = { instagram: 'Instagram login token (renewed automatically)', business: 'Business token (Meta Business / Facebook login)' };
    statusCard($('status-instagram'), 'Instagram gallery', [
      el('div', { className: 'status-line' }, igPill),
      instagram.account ? el('p', {}, 'Account: ', el('strong', { text: `@${instagram.account}` })) : null,
      el('p', { text: `${instagram.posts} posts shown. Last updated: ${formatTime(instagram.updatedAt)}.` }),
      instagram.kind ? el('p', { className: 'small-text', text: `${kindText[instagram.kind]}${instagram.tokenRenewedAt ? `. Last renewed ${formatTime(instagram.tokenRenewedAt)}.` : '.'}` }) : null,
      instagram.lastError ? el('p', { className: 'small-text', text: `${formatTime(instagram.lastError.at)}: ${instagram.lastError.message}` }) : null,
      isOwner() ? el('a', { href: '#settings', className: 'link', text: 'Instagram settings' }) : null,
    ]);
    showInboxBadge(data.status.inquiries);

    const inquiries = $('inquiries');
    if (!data.inquiries.length) {
      inquiries.replaceChildren(el('p', { className: 'muted', text: 'No inquiries yet.' }));
    } else {
      inquiries.replaceChildren(el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Received' }), el('th', { text: 'From' }), el('th', { text: 'Type' }))),
        el('tbody', {}, data.inquiries.map((q) => el('tr', {},
          el('td', { text: formatTime(q.receivedAt) }),
          el('td', {}, q.name || '', el('br'), el('span', { className: 'small-text', text: q.email || '' })),
          el('td', {}, q.type, ' ', q.handled ? pill('Handled', 'neutral') : pill('Needs reply', 'warn')),
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
      case 'inquiry-handled': return 'Marked an inquiry handled';
      case 'inquiry-reopened': return 'Marked an inquiry as needing a reply';
      case 'inquiry-marked-spam': return 'Moved an inquiry to Spam';
      case 'inquiry-not-spam': return 'Moved an inquiry out of Spam';
      case 'inquiry-deleted': return 'Deleted an inquiry';
      case 'inquiry-resent': return `Emailed an inquiry again (${details.ok ? 'worked' : 'failed'})`;
      case 'inquiries-exported': return 'Downloaded inquiries as a spreadsheet';
      case 'inquiries-spam-deleted': return `Deleted all spam (${details.count || 0})`;
      case 'two-factor-on': return 'Turned on two-step sign-in';
      case 'two-factor-off': return 'Turned off two-step sign-in';
      case 'recovery-codes-renewed': return 'Made new recovery codes';
      case 'admin-added': return `Added ${details.role === 'editor' ? 'editor' : 'owner'} "${details.admin}"`;
      case 'admin-removed': return `Removed admin "${details.admin}"`;
      case 'admin-role-changed': return `Made "${details.admin}" ${details.role === 'editor' ? 'an editor' : 'an owner'}`;
      case 'admin-password-set': return `Set a new password for "${details.admin}"`;
      case 'admin-two-factor-off': return `Turned off two-step sign-in for "${details.admin}"`;
      case 'backup-downloaded': return details.automatic ? 'Downloaded an automatic backup' : 'Downloaded a backup';
      case 'backup-restored': return 'Restored a backup';
      case 'backup-restore-failed': return 'Tried to restore a backup (failed)';
      default: return entry.action;
    }
  }

  // ---------- Inbox ----------

  const INBOX_VIEWS = [['open', 'Needs reply'], ['handled', 'Handled'], ['spam', 'Spam'], ['all', 'All']];
  const DELIVERY_PILLS = {
    sent: ['Emailed to you', 'ok'], failed: ['Email failed', 'bad'], 'not-configured': ['Not emailed (email not set up)', 'warn'],
    pending: ['Sending…', 'neutral'], skipped: ['Not emailed', 'neutral'],
  };
  const INBOX_PAGE = 25;
  const inbox = { view: 'open', q: '', items: [], total: 0, counts: null };
  const viewOf = (q) => (q.spam ? 'spam' : q.handled ? 'handled' : 'open');

  function showInboxBadge(counts) {
    if (!counts) return;
    const badge = $('inbox-badge');
    badge.hidden = !counts.open;
    badge.textContent = String(counts.open);
    badge.title = `${counts.open} waiting for a reply`;
  }

  function inboxQuery(extra = {}) {
    const params = { view: inbox.view, ...extra };
    if (inbox.q) params.q = inbox.q;
    return new URLSearchParams(params).toString();
  }

  async function loadInbox({ append = false } = {}) {
    const data = await api(`/inquiries?${inboxQuery({ offset: append ? inbox.items.length : 0, limit: INBOX_PAGE })}`);
    inbox.items = append ? inbox.items.concat(data.items) : data.items;
    inbox.total = data.total;
    inbox.counts = data.counts;
    renderInbox();
  }

  function renderInbox() {
    const counts = inbox.counts || {};
    showInboxBadge(inbox.counts);
    $('inbox-views').replaceChildren(...INBOX_VIEWS.map(([key, label]) => {
      const button = el('button', { type: 'button', className: 'button small', 'aria-pressed': String(inbox.view === key) },
        `${label} (${counts[key] || 0})`);
      button.addEventListener('click', () => {
        inbox.view = key;
        setResult($('inbox-result'), '', true);
        loadInbox().catch((err) => setResult($('inbox-result'), err.message, false));
      });
      return button;
    }));
    $('inbox-export').href = `/api/admin/inquiries/export.csv?${inboxQuery()}`;
    $('inbox-delete-spam').hidden = !(inbox.view === 'spam' && counts.spam);

    const list = $('inbox-list');
    if (!inbox.items.length) {
      const empty = inbox.q ? 'Nothing matches your search.'
        : { open: 'All caught up: nothing is waiting for a reply.', handled: 'No handled inquiries yet.', spam: 'No spam.', all: 'No inquiries yet.' }[inbox.view];
      list.replaceChildren(el('p', { className: 'muted', text: empty }));
    } else {
      list.replaceChildren(...inbox.items.map(inquiryCard));
    }
    $('inbox-more').hidden = inbox.items.length >= inbox.total;
  }

  // Updates one inquiry in place after an action, or removes it when it no longer belongs in this view.
  function applyInquiry(id, data, removed = false) {
    if (data.counts) inbox.counts = data.counts;
    const index = inbox.items.findIndex((q) => q.id === id);
    if (index !== -1) {
      if (removed || (data.inquiry && inbox.view !== 'all' && viewOf(data.inquiry) !== inbox.view)) {
        inbox.items.splice(index, 1);
        inbox.total -= 1;
      } else if (data.inquiry) inbox.items[index] = data.inquiry;
    }
    renderInbox();
  }

  function inquiryCard(q) {
    const result = $('inbox-result');
    const act = (button, request, message, removes = false) => {
      button.addEventListener('click', withBusy(button, async () => {
        try {
          const data = await request();
          applyInquiry(q.id, data, removes);
          setResult(result, data.message || message, true);
        } catch (err) {
          setResult(result, err.message, false);
          if (err.status === 404 || err.status === 502) await loadInbox().catch(() => {});
        }
      }));
      return button;
    };
    const put = (body) => () => api(`/inquiries/${q.id}`, { method: 'PUT', body });

    const pills = [q.spam ? pill('Spam', 'warn') : q.handled ? pill('Handled', 'neutral') : pill('Needs reply', 'warn')];
    if (!q.spam && q.delivery && DELIVERY_PILLS[q.delivery.status]) {
      const [text, kind] = DELIVERY_PILLS[q.delivery.status];
      const badge = pill(text, kind);
      if (q.delivery.error) badge.title = q.delivery.error;
      pills.push(badge);
    }
    const address = `${encodeURIComponent(q.email).replace(/%40/g, '@')}`;
    const facts = [
      el('span', {}, 'Email: ', el('a', { href: `mailto:${address}`, text: q.email })),
      q.phone ? el('span', {}, 'Phone: ', el('a', { href: `tel:${q.phone.replace(/[^0-9+]/g, '')}`, text: q.phone })) : null,
      el('span', { text: `Type: ${q.type}` }),
      q.eventDate ? el('span', { text: `Event date: ${q.eventDate}` }) : null,
      q.quantity ? el('span', { text: `How many: ${q.quantity}` }) : null,
    ];

    const actions = [];
    if (!q.spam) {
      actions.push(el('a', { className: 'button small primary', href: `mailto:${address}?subject=${encodeURIComponent('Your cupcake inquiry')}`, text: 'Reply by email' }));
      actions.push(act(el('button', { type: 'button', className: 'button small', text: q.handled ? 'Mark as needing a reply' : 'Mark handled' }),
        put({ handled: !q.handled }), q.handled ? 'Moved back to Needs reply.' : 'Marked handled.'));
      if (!q.delivery || q.delivery.status !== 'sent') {
        actions.push(act(el('button', { type: 'button', className: 'button small', text: 'Email it to me' }),
          () => api(`/inquiries/${q.id}/resend`, { method: 'POST', body: {} }), 'Emailed.'));
      }
      actions.push(act(el('button', { type: 'button', className: 'button small', text: 'Move to spam' }), put({ spam: true }), 'Moved to Spam.'));
    } else {
      actions.push(act(el('button', { type: 'button', className: 'button small', text: 'Not spam' }), put({ spam: false }),
        'Moved to Needs reply. Use "Email it to me" if you want a copy in your email.'));
    }
    const remove = el('button', { type: 'button', className: 'button small link-like danger', text: 'Delete' });
    remove.addEventListener('click', (event) => {
      if (!window.confirm(`Delete the inquiry from ${q.name || q.email}? This can't be undone.`)) event.stopImmediatePropagation();
    });
    actions.push(act(remove, () => api(`/inquiries/${q.id}`, { method: 'DELETE' }), 'Deleted.', true));

    return el('article', { className: `card inquiry${q.handled ? ' is-handled' : ''}` },
      el('div', { className: 'inquiry-head' },
        el('h2', { text: q.name || '(no name)' }),
        el('span', { className: 'small-text', text: formatTime(q.receivedAt) })),
      el('div', { className: 'inquiry-pills' }, pills,
        q.handled && q.handledBy ? el('span', { className: 'small-text', text: `by ${q.handledBy}, ${formatTime(q.handledAt)}` }) : null),
      el('div', { className: 'inquiry-facts' }, facts),
      el('p', { className: 'inquiry-message', text: q.message }),
      el('div', { className: 'inquiry-actions' }, actions));
  }

  const inboxSearch = $('inbox-search');
  let searchTimer = null;
  const runSearch = () => {
    clearTimeout(searchTimer);
    inbox.q = inboxSearch.value.trim();
    loadInbox().catch((err) => setResult($('inbox-result'), err.message, false));
  };
  $('inbox-search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch();
  });
  inboxSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 350);
  });
  const moreButton = $('inbox-more');
  moreButton.addEventListener('click', withBusy(moreButton, async () => {
    try {
      await loadInbox({ append: true });
    } catch (err) {
      setResult($('inbox-result'), err.message, false);
    }
  }));
  const deleteSpamButton = $('inbox-delete-spam');
  deleteSpamButton.addEventListener('click', withBusy(deleteSpamButton, async () => {
    if (!window.confirm('Delete every message in Spam? This can\'t be undone.')) return;
    try {
      const data = await api('/inquiries/delete-spam', { method: 'POST', body: {} });
      setResult($('inbox-result'), `Deleted ${data.removed} spam message${data.removed === 1 ? '' : 's'}.`, true);
      await loadInbox();
    } catch (err) {
      setResult($('inbox-result'), err.message, false);
    }
  }));
  $('inbox-export').addEventListener('click', () => {
    setResult($('inbox-result'), 'Downloading… The file opens in Excel, Numbers or Google Sheets.', true);
  });

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
    else if (setting.type === 'digits') Object.assign(props, { type: 'text', inputmode: 'numeric', maxlength: setting.max, autocomplete: 'off' });
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

  // ---------- Pages (content editor) ----------

  let contentState = null;
  let contentDirty = false;
  let contentMeta = null;
  // What the editor shows: a page id, 'site' (site-wide settings) or 'new' (the add-a-page form).
  let editing = 'home';
  const expanded = new Set();
  let addingBlock = false;

  const blockTypes = () => contentMeta.editor.blockTypes;
  const typeInfo = (type) => blockTypes().find((t) => t.type === type);
  const pageById = (id) => contentState.pages.find((p) => p.id === id);
  const pageTitle = (page) => (page.id === 'home' ? 'Home' : page.title || 'Untitled page');
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  }

  function slugify(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  }

  function uniqueSlug(base, exceptId) {
    const reserved = contentMeta.editor.reservedSlugs;
    let slug = base || 'page';
    for (let n = 2; reserved.includes(slug) || contentState.pages.some((p) => p.id !== exceptId && p.slug === slug); n += 1) slug = `${base || 'page'}-${n}`;
    return slug;
  }

  const ANCHOR_BASE = { hero: 'top-banner', text: 'text', imageText: 'photo-text', gallery: 'gallery', cards: 'cards', steps: 'steps', contact: 'contact' };
  function uniqueAnchor(page, type, exceptId) {
    if (type === 'hero') return '';
    const reserved = contentMeta.editor.reservedAnchors;
    const base = ANCHOR_BASE[type] || 'section';
    let name = base;
    for (let n = 2; reserved.includes(name) || page.blocks.some((b) => b.id !== exceptId && b.anchor === name); n += 1) name = `${base}-${n}`;
    return name;
  }

  function markDirty() {
    contentDirty = true;
    showContentStatus();
    schedulePreview();
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

  function selectField(id, label, options, value, onChange, help) {
    const box = el('select', { id });
    for (const [key, text] of options) {
      const option = el('option', { value: key, text });
      option.selected = key === value;
      box.append(option);
    }
    box.addEventListener('change', () => {
      onChange(box.value);
      markDirty();
    });
    return el('div', { className: 'setting' }, el('label', { for: id, text: label }), box, help ? el('div', { className: 'small-text', text: help }) : null);
  }

  // ---------- Links (buttons and menu items) ----------

  // Every place a button or menu item can go: pages, blocks with a link name, Instagram and email.
  function targetSelect(id, value, { allowNone = true, onChange }) {
    const box = el('select', { id });
    if (allowNone) box.append(el('option', { value: '', text: '(no link: the button is hidden)' }));
    const pagesGroup = el('optgroup', { label: 'Pages' });
    for (const page of contentState.pages) pagesGroup.append(el('option', { value: `page:${page.id}`, text: pageTitle(page) }));
    box.append(pagesGroup);
    for (const page of contentState.pages) {
      const group = el('optgroup', { label: `Blocks on ${pageTitle(page)}` });
      for (const block of page.blocks) {
        if (!block.anchor) continue;
        const info = typeInfo(block.type);
        const name = block.heading || block.name || '';
        group.append(el('option', { value: `block:${page.id}:${block.id}`, text: `${info ? info.label : block.type}${name ? `: ${name}` : ''}${block.visible === false ? ' (hidden)' : ''}` }));
      }
      if (group.children.length) box.append(group);
    }
    const other = el('optgroup', { label: 'Other' });
    other.append(el('option', { value: 'instagram', text: 'Instagram page' }), el('option', { value: 'email', text: 'Email us' }));
    box.append(other);
    box.value = value || '';
    if (box.value !== (value || '')) {
      // A link to something that was removed: show it as missing rather than silently changing it.
      box.append(el('option', { value, text: '(missing: choose another)' }));
      box.value = value;
    }
    box.addEventListener('change', () => {
      onChange(box.value);
      markDirty();
    });
    return box;
  }

  function buttonField(id, field, value, onChange) {
    const current = value && typeof value === 'object' ? value : { label: '', target: '' };
    const label = el('input', { id: `${id}-label`, type: 'text', maxlength: 60, autocomplete: 'off', placeholder: 'Button text' });
    label.value = current.label || '';
    label.addEventListener('input', () => {
      current.label = label.value;
      onChange(current);
      markDirty();
    });
    const target = targetSelect(`${id}-target`, current.target, { onChange: (v) => {
      current.target = v;
      onChange(current);
    } });
    return el('div', { className: 'setting' },
      el('label', { for: `${id}-label`, text: field.label }),
      el('div', { className: 'two-fields' }, label, target),
      el('div', { className: 'small-text', text: 'The button shows when it has both text and somewhere to go.' }));
  }

  // Removes links that point at a removed page or block (menu items go; buttons lose their target).
  function forgetLinks(isGone) {
    contentState.site.menu = contentState.site.menu.filter((item) => !isGone(item.target));
    for (const page of contentState.pages) {
      for (const block of page.blocks) {
        for (const value of Object.values(block)) {
          if (value && typeof value === 'object' && !Array.isArray(value) && 'target' in value && isGone(value.target)) value.target = '';
        }
      }
    }
  }

  function linksTo(isTarget) {
    let count = contentState.site.menu.filter((item) => isTarget(item.target)).length;
    for (const page of contentState.pages) {
      for (const block of page.blocks) {
        for (const value of Object.values(block)) {
          if (value && typeof value === 'object' && !Array.isArray(value) && 'target' in value && isTarget(value.target)) count += 1;
        }
      }
    }
    return count;
  }

  // ---------- Fields of a block ----------

  function renderListField(block, field, prefix) {
    const items = block[field.key];
    const wrap = el('div', { className: 'list-field' }, el('h4', { text: field.label }));
    items.forEach((item, index) => {
      const tools = el('div', { className: 'item-tools' });
      const button = (label, title, disabled, action) => {
        const b = el('button', { type: 'button', className: 'button', text: label, title, 'aria-label': title, disabled });
        b.addEventListener('click', () => {
          action();
          markDirty();
          renderContentForm();
        });
        tools.append(b);
      };
      const name = item.name || item.title || `${field.itemLabel} ${index + 1}`;
      button('↑', `Move "${name}" up`, index === 0, () => {
        [items[index - 1], items[index]] = [items[index], items[index - 1]];
      });
      button('↓', `Move "${name}" down`, index === items.length - 1, () => {
        [items[index + 1], items[index]] = [items[index], items[index + 1]];
      });
      const remove = el('button', { type: 'button', className: 'button', text: 'Remove', title: `Remove "${name}"` });
      remove.addEventListener('click', () => {
        if (!window.confirm(`Remove "${name}"? (Nothing changes on the website until you publish.)`)) return;
        items.splice(index, 1);
        markDirty();
        renderContentForm();
      });
      tools.append(remove);
      const box = el('div', { className: 'list-item' },
        el('div', { className: 'list-item-head' }, el('strong', { text: `${field.itemLabel} ${index + 1}` }), tools));
      for (const sub of field.fields) {
        const node = renderField(item, sub, `${prefix}-${index}`);
        if (node) box.append(node);
      }
      wrap.append(box);
    });
    const add = el('button', { type: 'button', className: 'button', text: field.addLabel, disabled: items.length >= field.max });
    add.addEventListener('click', () => {
      items.push(clone(field.blank));
      markDirty();
      renderContentForm();
      const first = document.getElementById(`${prefix}-${items.length - 1}-${field.fields[0].key}`);
      if (first) first.focus();
    });
    wrap.append(add);
    return wrap;
  }

  function renderField(target, field, prefix) {
    const id = `${prefix}-${field.key}`;
    const set = (value) => {
      target[field.key] = value;
    };
    switch (field.kind) {
      case 'text': return textField(id, field.label, target[field.key], field.max, false, field.help, set);
      case 'textarea': return textField(id, field.label, target[field.key], field.max, true, field.help, set);
      case 'photo': return photoPicker(id, field.label, target[field.key], field.help, set);
      case 'button': return buttonField(id, field, target[field.key], set);
      case 'photos': return renderGalleryPhotos(target, id);
      case 'list': return renderListField(target, field, id);
      case 'choice': {
        const radios = field.options.map(([value, label]) => {
          const radio = el('input', { type: 'radio', name: id, value, id: `${id}-${value}` });
          radio.checked = target[field.key] === value;
          radio.addEventListener('change', () => {
            set(value);
            markDirty();
            renderContentForm();
          });
          return el('label', { for: `${id}-${value}` }, radio, label);
        });
        return el('fieldset', { className: 'setting radio-field' }, el('legend', { text: field.label }), el('div', { className: 'radio-row' }, radios));
      }
      default: return null;
    }
  }

  // ---------- Blocks ----------

  function blockSummary(block) {
    const text = block.heading || block.body || block.name || '';
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }

  function moveBlock(page, from, to) {
    if (to < 0 || to >= page.blocks.length || from === to) return;
    const [moved] = page.blocks.splice(from, 1);
    page.blocks.splice(to, 0, moved);
    markDirty();
    renderContentForm();
  }

  let dragging = null;

  function renderBlock(page, block, index) {
    const info = typeInfo(block.type) || { label: block.type, fields: [], background: false, anchor: 'required' };
    const key = `${page.id}:${block.id}`;
    const open = expanded.has(key);
    const tools = el('div', { className: 'item-tools' });
    const tool = (text, title, disabled, action, className = 'button') => {
      const b = el('button', { type: 'button', className, text, title, 'aria-label': title, disabled });
      b.addEventListener('click', action);
      tools.append(b);
      return b;
    };
    tool('↑', `Move ${info.label} up`, index === 0, () => moveBlock(page, index, index - 1));
    tool('↓', `Move ${info.label} down`, index === page.blocks.length - 1, () => moveBlock(page, index, index + 1));
    tool(block.visible ? 'Hide' : 'Show', block.visible ? `Hide this ${info.label.toLowerCase()} block on the website` : `Show this ${info.label.toLowerCase()} block on the website`, false, () => {
      block.visible = !block.visible;
      markDirty();
      renderContentForm();
    });
    const singleTaken = info.single && page.blocks.some((b) => b !== block && b.type === block.type);
    tool('Copy', `Duplicate this ${info.label.toLowerCase()} block`, info.single || singleTaken || page.blocks.length >= contentMeta.editor.maxBlocks, () => {
      const copy = clone(block);
      copy.id = randomId();
      copy.anchor = uniqueAnchor(page, copy.type, copy.id);
      page.blocks.splice(index + 1, 0, copy);
      expanded.add(`${page.id}:${copy.id}`);
      markDirty();
      renderContentForm();
    });
    tool('Delete', `Delete this ${info.label.toLowerCase()} block`, false, () => {
      const target = `block:${page.id}:${block.id}`;
      const links = linksTo((t) => t === target);
      if (!window.confirm(`Delete this ${info.label.toLowerCase()} block${block.heading ? ` ("${block.heading}")` : ''}?${links ? ` ${links} button${links === 1 ? '' : 's'} or menu item${links === 1 ? '' : 's'} linking to it will be removed too.` : ''} (Nothing changes on the website until you publish.)`)) return;
      forgetLinks((t) => t === target);
      page.blocks.splice(index, 1);
      markDirty();
      renderContentForm();
    }, 'button link-like danger');

    const toggle = el('button', { type: 'button', className: 'block-toggle', 'aria-expanded': String(open) },
      el('strong', { text: info.label }),
      el('span', { className: 'block-summary', text: blockSummary(block) }),
      block.visible ? null : pill('Hidden', 'warn'));
    toggle.addEventListener('click', () => {
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      renderContentForm();
      if (expanded.has(key)) scrollPreviewTo(block.id);
    });

    // Browsers don't start a drag from inside a button, so the handle is its own element.
    const handle = el('span', { className: 'drag-handle', draggable: 'true', title: 'Drag to move (or use the arrows)', 'aria-hidden': 'true', text: '⋮⋮' });
    const head = el('div', { className: 'block-head' }, handle, toggle, tools);
    const card = el('div', { className: `block-card${open ? ' open' : ''}${block.visible ? '' : ' is-hidden'}`, 'data-block-id': block.id }, head);
    handle.addEventListener('dragstart', (event) => {
      dragging = { page: page.id, index };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', block.id);
      event.dataTransfer.setDragImage(card, 20, 20);
      card.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => {
      dragging = null;
      card.classList.remove('dragging');
      for (const other of document.querySelectorAll('.block-card.drop-before, .block-card.drop-after')) other.classList.remove('drop-before', 'drop-after');
    });
    card.addEventListener('dragover', (event) => {
      if (!dragging || dragging.page !== page.id) return;
      event.preventDefault();
      const box = card.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      card.classList.toggle('drop-after', after);
      card.classList.toggle('drop-before', !after);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
    card.addEventListener('drop', (event) => {
      if (!dragging || dragging.page !== page.id) return;
      event.preventDefault();
      const after = card.classList.contains('drop-after');
      const from = dragging.index;
      let to = index + (after ? 1 : 0);
      if (from < to) to -= 1;
      dragging = null;
      moveBlock(page, from, to);
    });
    card.addEventListener('focusin', () => scrollPreviewTo(block.id));

    if (open) {
      const body = el('div', { className: 'block-body' });
      const prefix = `blk-${block.id}`;
      for (const field of info.fields) {
        const node = renderField(block, field, prefix);
        if (node) body.append(node);
      }
      // Layout details: the block's link name and background.
      const advanced = el('details', { className: 'block-advanced' }, el('summary', { text: 'Link name and background' }));
      advanced.append(textField(`${prefix}-anchor`, info.anchor === 'optional' ? 'Link name (optional)' : 'Link name', block.anchor, 40, false,
        `Used for links straight to this block, for example frostedharmony.com/${page.slug ? `${page.slug}` : ''}#${block.anchor || 'name'}. Lowercase letters, numbers and dashes.`,
        (v) => {
          block.anchor = v.trim().toLowerCase();
        }));
      if (info.background) {
        advanced.append(selectField(`${prefix}-background`, 'Background', [['auto', 'Automatic (alternates down the page)'], ['plain', 'Plain'], ['tinted', 'Tinted']],
          block.background || 'auto', (v) => {
            block.background = v;
          }));
      }
      body.append(advanced);
      card.append(body);
    }
    return card;
  }

  function renderAddBlock(page) {
    const wrap = el('div', { className: 'add-block' });
    const full = page.blocks.length >= contentMeta.editor.maxBlocks;
    const button = el('button', { type: 'button', className: 'button primary', text: addingBlock ? 'Close' : '+ Add a block', disabled: full, 'aria-expanded': String(addingBlock) });
    button.addEventListener('click', () => {
      addingBlock = !addingBlock;
      renderContentForm();
    });
    wrap.append(button);
    if (full) wrap.append(el('p', { className: 'small-text', text: `A page can have at most ${contentMeta.editor.maxBlocks} blocks.` }));
    if (addingBlock && !full) {
      wrap.append(el('div', { className: 'block-types' }, blockTypes().map((type) => {
        const taken = type.single && page.blocks.some((b) => b.type === type.type);
        const choice = el('button', { type: 'button', className: 'block-type', disabled: taken },
          el('strong', { text: type.label }), el('span', { text: taken ? 'Already on this page (one per page).' : type.description }));
        choice.addEventListener('click', () => {
          const block = { id: randomId(), type: type.type, visible: true, anchor: '', ...clone(type.defaults) };
          if (type.background) block.background = 'auto';
          block.anchor = uniqueAnchor(page, type.type, block.id);
          page.blocks.push(block);
          expanded.add(`${page.id}:${block.id}`);
          addingBlock = false;
          markDirty();
          renderContentForm();
          scrollPreviewTo(block.id);
          const card = document.querySelector(`[data-block-id="${block.id}"]`);
          if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        return choice;
      })));
    }
    return wrap;
  }

  // ---------- A page ----------

  const menuItemFor = (page) => contentState.site.menu.find((item) => item.target === `page:${page.id}`);

  function renderPageSettings(page) {
    const card = el('fieldset', { className: 'card settings-group' }, el('legend', {}, el('h2', { text: `${pageTitle(page)}: page settings` })));
    const prefix = `page-${page.id}`;
    if (page.id !== 'home') {
      card.append(textField(`${prefix}-title`, 'Page name', page.title, 40, false, 'Shown in this editor and used as the menu text when the page is added to the menu.', (v) => {
        page.title = v;
      }));
      const slug = el('input', { id: `${prefix}-slug`, type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: 60 });
      slug.value = page.slug;
      slug.addEventListener('input', () => {
        page.slug = slug.value.trim().toLowerCase();
        markDirty();
      });
      slug.addEventListener('change', () => {
        page.slug = slugify(slug.value) || page.slug;
        slug.value = page.slug;
        markDirty();
      });
      card.append(el('div', { className: 'setting' },
        el('label', { for: `${prefix}-slug`, text: 'Web address' }),
        el('div', { className: 'slug-row' }, el('span', { className: 'muted', text: `${contentState.site.siteUrl.replace(/^https:\/\//, '')}/` }), slug),
        el('div', { className: 'small-text', text: 'Lowercase letters, numbers and dashes. Changing it breaks links people saved to the old address.' })));
    }

    const inMenu = el('input', { type: 'checkbox', id: `${prefix}-menu` });
    const item = menuItemFor(page);
    inMenu.checked = Boolean(item);
    inMenu.addEventListener('change', () => {
      if (inMenu.checked) {
        if (contentState.site.menu.length >= contentMeta.editor.maxMenu) {
          inMenu.checked = false;
          window.alert(`The menu can have at most ${contentMeta.editor.maxMenu} items. Remove one in Site-wide settings first.`);
          return;
        }
        // New pages go before any menu button (such as "Inquire"), which stays last.
        const menu = contentState.site.menu;
        const firstButton = menu.findIndex((m) => m.style === 'button');
        menu.splice(firstButton === -1 ? menu.length : firstButton, 0, { label: pageTitle(page).slice(0, 30), target: `page:${page.id}`, style: 'link' });
      } else {
        contentState.site.menu = contentState.site.menu.filter((m) => m.target !== `page:${page.id}`);
      }
      markDirty();
      renderContentForm();
    });
    card.append(el('div', { className: 'setting check-row' }, el('label', { for: `${prefix}-menu` }, inMenu, 'Show this page in the menu')));
    if (item) {
      card.append(textField(`${prefix}-menu-label`, 'Menu text', item.label, 30, false, 'Reorder the menu in Site-wide settings.', (v) => {
        item.label = v;
      }));
    }

    const seo = el('details', { className: 'block-advanced' }, el('summary', { text: 'Browser tab, search engines and link previews' }));
    seo.append(
      textField(`${prefix}-seo-title`, 'Browser tab title', page.seo.title, 70, false, 'Also the title Google shows. Keep it under about 60 characters.', (v) => {
        page.seo.title = v;
      }),
      textField(`${prefix}-seo-description`, 'Search engine description', page.seo.description, 300, true, 'The short summary Google shows under the title.', (v) => {
        page.seo.description = v;
      }),
      photoPicker(`${prefix}-seo-image`, 'Link preview photo (optional)', page.seo.shareImage, 'Shown when someone shares this page on Facebook, iMessage, WhatsApp and similar apps.', (id) => {
        page.seo.shareImage = id;
      }));
    card.append(seo);

    if (page.id !== 'home') {
      const actions = el('div', { className: 'group-actions' });
      const copy = el('button', { type: 'button', className: 'button', text: 'Duplicate page', disabled: contentState.pages.length >= contentMeta.editor.maxPages });
      copy.addEventListener('click', () => {
        const duplicate = clone(page);
        duplicate.id = randomId();
        duplicate.title = `${page.title} (copy)`.slice(0, 40);
        duplicate.slug = uniqueSlug(`${page.slug}-copy`, duplicate.id);
        const idMap = new Map();
        for (const block of duplicate.blocks) {
          const next = randomId();
          idMap.set(block.id, next);
          block.id = next;
        }
        // Buttons that linked within the original page now link within the copy.
        for (const block of duplicate.blocks) {
          for (const value of Object.values(block)) {
            if (!value || typeof value !== 'object' || Array.isArray(value) || !('target' in value)) continue;
            const [kind, pid, bid] = String(value.target).split(':');
            if (kind === 'block' && pid === page.id && idMap.has(bid)) value.target = `block:${duplicate.id}:${idMap.get(bid)}`;
            else if (kind === 'page' && pid === page.id) value.target = `page:${duplicate.id}`;
          }
        }
        contentState.pages.push(duplicate);
        editing = duplicate.id;
        markDirty();
        renderContentForm();
      });
      const remove = el('button', { type: 'button', className: 'button link-like danger', text: 'Delete this page' });
      remove.addEventListener('click', () => {
        const isTarget = (t) => t === `page:${page.id}` || String(t).startsWith(`block:${page.id}:`);
        const links = linksTo(isTarget);
        if (!window.confirm(`Delete the "${pageTitle(page)}" page?${links ? ` ${links} menu item${links === 1 ? '' : 's'} or button${links === 1 ? '' : 's'} linking to it will be removed too.` : ''} It stays on the website until you publish, and you can bring it back from "Published versions".`)) return;
        forgetLinks(isTarget);
        contentState.pages = contentState.pages.filter((p) => p !== page);
        editing = 'home';
        markDirty();
        renderContentForm();
      });
      actions.append(copy, remove);
      card.append(actions);
    }
    return card;
  }

  function renderPageEditor(page) {
    const blocksCard = el('div', { className: 'card' },
      el('h2', { text: 'Blocks' }),
      el('p', { className: 'small-text', text: 'The page is built from these blocks, top to bottom. Click a block to edit it; drag it or use the arrows to move it.' }));
    const list = el('div', { className: 'block-list' });
    if (!page.blocks.length) list.append(el('p', { className: 'muted', text: 'This page is empty. Add a block to start.' }));
    page.blocks.forEach((block, index) => list.append(renderBlock(page, block, index)));
    blocksCard.append(list, renderAddBlock(page));
    return [renderPageSettings(page), blocksCard];
  }

  // ---------- New page ----------

  function renderNewPage() {
    const card = el('form', { className: 'card', novalidate: true }, el('h2', { text: 'Add a page' }));
    if (contentState.pages.length >= contentMeta.editor.maxPages) {
      card.append(el('p', { text: `The website can have at most ${contentMeta.editor.maxPages} pages.` }));
      return [card];
    }
    const name = el('input', { id: 'new-page-name', type: 'text', maxlength: 40, autocomplete: 'off', placeholder: 'For example "About us" or "Wedding cupcakes"' });
    const slugPreview = el('span', { className: 'small-text' });
    const updateSlug = () => {
      slugPreview.textContent = name.value.trim() ? `Web address: ${contentState.site.siteUrl.replace(/^https:\/\//, '')}/${uniqueSlug(slugify(name.value))}` : '';
    };
    name.addEventListener('input', updateSlug);
    const templates = [
      ['banner-text', 'A top banner and a text block'],
      ['photo-text', 'A top banner and a photo-and-text block'],
      ['empty', 'An empty page'],
    ];
    const radios = templates.map(([value, label], i) => {
      const radio = el('input', { type: 'radio', name: 'new-page-template', value, id: `new-page-${value}` });
      radio.checked = i === 0;
      return el('label', { for: `new-page-${value}` }, radio, label);
    });
    const inMenu = el('input', { type: 'checkbox', id: 'new-page-menu' });
    inMenu.checked = contentState.site.menu.length < contentMeta.editor.maxMenu;
    inMenu.disabled = !inMenu.checked;
    const result = el('p', { role: 'status' });
    card.append(
      el('label', { for: 'new-page-name', text: 'Page name' }), name, slugPreview,
      el('fieldset', { className: 'setting radio-field' }, el('legend', { text: 'Start with' }), el('div', { className: 'radio-row' }, radios)),
      el('div', { className: 'setting check-row' }, el('label', { for: 'new-page-menu' }, inMenu, 'Show it in the menu')),
      el('button', { type: 'submit', className: 'button primary', text: 'Add page' }), result);
    card.addEventListener('submit', (event) => {
      event.preventDefault();
      const title = name.value.trim().replace(/\s+/g, ' ');
      if (!title) {
        setResult(result, 'Give the page a name.', false);
        name.focus();
        return;
      }
      const template = card.querySelector('input[name="new-page-template"]:checked').value;
      const page = {
        id: randomId(), slug: uniqueSlug(slugify(title)), title,
        seo: { title: `${title} | ${contentState.site.brand.name}`.slice(0, 70), description: pageById('home').seo.description, shareImage: '' },
        blocks: [],
      };
      const add = (type, extra = {}) => {
        const info = typeInfo(type);
        const block = { id: randomId(), type, visible: true, anchor: '', ...clone(info.defaults), ...extra };
        if (info.background) block.background = 'auto';
        block.anchor = uniqueAnchor(page, type, block.id);
        page.blocks.push(block);
        return block;
      };
      if (template !== 'empty') {
        add('hero', { heading: title, eyebrow: '', lead: '' });
        add(template === 'photo-text' ? 'imageText' : 'text');
      }
      contentState.pages.push(page);
      if (inMenu.checked) {
        const menu = contentState.site.menu;
        const firstButton = menu.findIndex((m) => m.style === 'button');
        menu.splice(firstButton === -1 ? menu.length : firstButton, 0, { label: title.slice(0, 30), target: `page:${page.id}`, style: 'link' });
      }
      for (const block of page.blocks) expanded.add(`${page.id}:${block.id}`);
      editing = page.id;
      markDirty();
      renderContentForm();
      setResult($('content-result'), `Added "${title}". Edit its blocks, then publish to put it live.`, true);
    });
    setTimeout(() => name.focus(), 0);
    return [card];
  }

  // ---------- Site-wide settings ----------

  function renderMenuEditor() {
    const menu = contentState.site.menu;
    const card = el('fieldset', { className: 'card settings-group' }, el('legend', {}, el('h2', { text: 'Menu' })),
      el('p', { className: 'small-text', text: 'The links at the top of every page, in this order. A link to a hidden block is left out automatically. "Button" makes an item stand out, like "Inquire".' }));
    menu.forEach((item, index) => {
      const tools = el('div', { className: 'item-tools' });
      const tool = (text, title, disabled, action) => {
        const b = el('button', { type: 'button', className: 'button', text, title, 'aria-label': title, disabled });
        b.addEventListener('click', () => {
          action();
          markDirty();
          renderContentForm();
        });
        tools.append(b);
      };
      tool('↑', `Move "${item.label}" up`, index === 0, () => {
        [menu[index - 1], menu[index]] = [menu[index], menu[index - 1]];
      });
      tool('↓', `Move "${item.label}" down`, index === menu.length - 1, () => {
        [menu[index + 1], menu[index]] = [menu[index], menu[index + 1]];
      });
      tool('Remove', `Remove "${item.label}" from the menu`, false, () => menu.splice(index, 1));
      const label = el('input', { id: `menu-${index}-label`, type: 'text', maxlength: 40, autocomplete: 'off', 'aria-label': `Menu item ${index + 1} text` });
      label.value = item.label;
      label.addEventListener('input', () => {
        item.label = label.value;
        markDirty();
      });
      const style = el('select', { id: `menu-${index}-style`, 'aria-label': `Menu item ${index + 1} style` },
        el('option', { value: 'link', text: 'Link' }), el('option', { value: 'button', text: 'Button' }));
      style.value = item.style;
      style.addEventListener('change', () => {
        item.style = style.value;
        markDirty();
      });
      const target = targetSelect(`menu-${index}-target`, item.target, { allowNone: false, onChange: (v) => {
        item.target = v;
      } });
      target.setAttribute('aria-label', `Menu item ${index + 1} goes to`);
      card.append(el('div', { className: 'menu-row' }, label, target, style, tools));
    });
    const add = el('button', { type: 'button', className: 'button', text: 'Add a menu item', disabled: menu.length >= contentMeta.editor.maxMenu });
    add.addEventListener('click', () => {
      const firstButton = menu.findIndex((m) => m.style === 'button');
      menu.splice(firstButton === -1 ? menu.length : firstButton, 0, { label: 'New link', target: 'page:home', style: 'link' });
      markDirty();
      renderContentForm();
    });
    card.append(add);
    return card;
  }

  function renderSiteSettings() {
    const site = contentState.site;
    const details = el('fieldset', { className: 'card settings-group' }, el('legend', {}, el('h2', { text: 'Business and contact details' })),
      el('p', { className: 'small-text', text: 'Shown on every page.' }));
    details.append(
      textField('site-brand-name', 'Business name', site.brand.name, 60, false, 'Shown in the header and footer.', (v) => {
        site.brand.name = v;
      }),
      textField('site-brand-tagline', 'Footer tagline', site.brand.tagline, 120, false, null, (v) => {
        site.brand.tagline = v;
      }),
      textField('site-links-email', 'Contact email address', site.links.email, 200, false, 'Shown with the contact form and in the footer.', (v) => {
        site.links.email = v;
      }),
      textField('site-links-instagram', 'Instagram page link', site.links.instagramUrl, 200, false, 'For example https://www.instagram.com/frostedharmony/. Leave empty to hide the Instagram links.', (v) => {
        site.links.instagramUrl = v;
      }));
    const design = el('fieldset', { className: 'card settings-group' }, el('legend', {}, el('h2', { text: 'Design: colors, fonts and logo' })), renderDesign());
    const address = el('fieldset', { className: 'card settings-group' }, el('legend', {}, el('h2', { text: 'Website address' })),
      textField('site-url', 'Website address', site.siteUrl, 200, false, 'Used for link previews and page addresses. Normally https://frostedharmony.com', (v) => {
        site.siteUrl = v;
      }));
    return [details, renderMenuEditor(), design, address];
  }

  // ---------- Putting the editor together ----------

  function renderPageTabs() {
    const tab = (id, label, extraClass = '') => {
      const b = el('button', { type: 'button', className: `page-tab${extraClass}`, 'aria-pressed': String(editing === id), text: label });
      b.addEventListener('click', () => {
        editing = id;
        addingBlock = false;
        renderContentForm();
        showPreviewPage();
      });
      return b;
    };
    $('page-tabs').replaceChildren(
      ...contentState.pages.map((page) => tab(page.id, pageTitle(page))),
      tab('new', '+ Add page', ' add'),
      tab('site', 'Site-wide: menu, design, contact details', ' site'));
  }

  function renderContentForm() {
    if (editing !== 'site' && editing !== 'new' && !pageById(editing)) editing = 'home';
    const form = $('content-form');
    const scroll = window.scrollY;
    renderPageTabs();
    let parts;
    if (editing === 'site') parts = renderSiteSettings();
    else if (editing === 'new') parts = renderNewPage();
    else parts = renderPageEditor(pageById(editing));
    form.replaceChildren(...parts);
    window.scrollTo(0, scroll);
  }

  // ---------- Live preview ----------

  const DEVICES = { phone: 390, tablet: 768, desktop: 1280 };
  let device = 'desktop';
  let previewBase = null;
  let previewTimer = null;
  let previewSeq = 0;
  let previewHidden = window.matchMedia('(max-width: 1180px)').matches;
  let frames = null;
  let pendingBlock = null;

  function previewSlug() {
    const page = editing === 'site' || editing === 'new' ? pageById('home') : pageById(editing);
    return page ? page.slug : '';
  }

  function setupFrames() {
    if (frames) return;
    const stage = $('preview-stage');
    const first = $('preview-frame');
    const second = el('iframe', { title: 'Preview of your changes', tabindex: '-1', className: 'back' });
    stage.append(second);
    frames = [first, second];
    new ResizeObserver(() => sizeFrames()).observe(stage);
  }

  // The preview keeps the real page width (phone, tablet or desktop) and is scaled down to fit.
  function sizeFrames() {
    if (!frames) return;
    const stage = $('preview-stage');
    const width = DEVICES[device];
    const scale = Math.min(1, stage.clientWidth / width);
    const left = Math.max(0, Math.round((stage.clientWidth - width * scale) / 2));
    for (const frame of frames) {
      frame.style.setProperty('left', `${left}px`);
      frame.style.setProperty('width', `${width}px`);
      frame.style.setProperty('height', `${Math.round(stage.clientHeight / scale)}px`);
      frame.style.setProperty('transform', `scale(${scale})`);
    }
  }

  // Loads the new preview behind the current one and swaps when it's ready, so it doesn't flash.
  function loadPreviewFrame() {
    if (!previewBase || previewHidden) return;
    setupFrames();
    sizeFrames();
    const [front, back] = frames;
    const slug = previewSlug();
    let scroll = 0;
    try {
      if (front.dataset.slug === slug && front.contentWindow) scroll = front.contentWindow.scrollY;
    } catch {
      scroll = 0;
    }
    back.onload = () => {
      try {
        back.contentWindow.scrollTo(0, scroll);
      } catch {
        // Not loaded as expected; the swap still shows whatever arrived.
      }
      back.classList.remove('back');
      front.classList.add('back');
      frames = [back, front];
      if (pendingBlock) scrollPreviewTo(pendingBlock);
    };
    back.dataset.slug = slug;
    back.src = `${previewBase}/${slug}`;
  }

  function showPreviewProblems(errors) {
    const box = $('preview-problems');
    box.hidden = !errors.length;
    if (!errors.length) return;
    const shown = errors.slice(0, 6);
    box.replaceChildren(...[el('strong', { text: 'Fix before publishing:' }),
      el('ul', {}, shown.map((e) => el('li', { text: e }))),
      errors.length > shown.length ? el('p', { className: 'small-text', text: `…and ${errors.length - shown.length} more.` }) : null].filter(Boolean));
  }

  async function refreshPreview({ force = false } = {}) {
    if (!contentState || currentPage() !== 'content' || (previewHidden && !force)) return;
    const seq = ++previewSeq;
    $('preview-status').textContent = 'Updating…';
    try {
      const data = await api('/content/live-preview', { method: 'POST', body: { content: contentState } });
      if (seq !== previewSeq) return;
      previewBase = data.base;
      showPreviewProblems(data.errors);
      loadPreviewFrame();
      $('preview-status').textContent = previewHidden ? '' : 'Up to date';
    } catch (err) {
      if (seq === previewSeq && err.status !== 401) $('preview-status').textContent = `Preview not updated: ${err.message}`;
    }
  }

  function schedulePreview(delay = 450) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, delay);
  }

  function showPreviewPage() {
    if (!frames || frames[0].dataset.slug !== previewSlug()) loadPreviewFrame();
  }

  // Scrolls the preview to a block and outlines it for a moment.
  function scrollPreviewTo(blockId) {
    pendingBlock = blockId;
    if (!frames) return;
    let target = null;
    try {
      target = frames[0].contentDocument && frames[0].contentDocument.querySelector(`[data-block="${blockId}"]`);
    } catch {
      target = null;
    }
    if (!target) return;
    pendingBlock = null;
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    target.style.setProperty('outline', '3px solid #d94f6b');
    target.style.setProperty('outline-offset', '-3px');
    setTimeout(() => {
      target.style.removeProperty('outline');
      target.style.removeProperty('outline-offset');
    }, 1400);
  }

  for (const button of document.querySelectorAll('[data-device]')) {
    button.addEventListener('click', () => {
      device = button.dataset.device;
      for (const other of document.querySelectorAll('[data-device]')) other.setAttribute('aria-pressed', String(other === button));
      sizeFrames();
    });
  }

  function applyPreviewVisibility() {
    document.querySelector('.editor-layout').classList.toggle('preview-hidden', previewHidden);
    $('preview-toggle').textContent = previewHidden ? 'Show preview' : 'Hide preview';
    $('preview-toggle').setAttribute('aria-expanded', String(!previewHidden));
    if (!previewHidden) {
      if (previewBase) loadPreviewFrame();
      else schedulePreview(0);
    }
  }
  $('preview-toggle').addEventListener('click', () => {
    previewHidden = !previewHidden;
    applyPreviewVisibility();
  });
  applyPreviewVisibility();
  // The preview sits just below the sticky publish bar, whose height depends on the window width.
  new ResizeObserver(([entry]) => {
    document.documentElement.style.setProperty('--publish-bar-height', `${Math.ceil(entry.target.getBoundingClientRect().height)}px`);
  }).observe(document.querySelector('#page-content .publish-bar'));

  // ---------- Status, history and saving ----------

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
      schedulePreview(0);
    }
    renderHistory(data.history);
    showContentStatus();
  }

  async function loadContent() {
    if (contentDirty && !window.confirm('Discard your unsaved edits and reload the page content?')) {
      schedulePreview(0);
      return;
    }
    const [data, library] = await Promise.all([api('/content'), api('/media')]);
    photosCache = library.photos;
    applyContentResponse(data);
    setResult($('content-result'), '', true);
  }

  async function saveContent({ quiet = false } = {}) {
    const data = await api('/content', { method: 'PUT', body: { content: contentState, revision: contentMeta.revision } });
    applyContentResponse(data);
    if (!quiet) setResult($('content-result'), 'Draft saved. Check the preview, then publish when ready.', true);
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
      setResult($('content-result'), publish ? 'Done. That version is live now.' : 'Copied into your draft. Check the preview, then publish when ready.', true);
    });
  }

  $('content-save').addEventListener('click', withBusy($('content-save'), () => contentAction(() => saveContent())));

  $('content-preview').addEventListener('click', withBusy($('content-preview'), () => contentAction(async () => {
    // Open the tab first (browsers block pop-ups opened after a delay), then point it at the preview.
    const tab = window.open('', '_blank');
    try {
      clearTimeout(previewTimer);
      await refreshPreview({ force: true });
      if (tab) tab.location.href = `${previewBase}/${previewSlug()}`;
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
      wrap.replaceChildren(...[el('label', { for: id, text: label }), picker, help ? el('div', { className: 'small-text', text: help }) : null].filter(Boolean));
    };
    render();
    return wrap;
  }

  // The gallery block's own photos, in order.
  function renderGalleryPhotos(gallery, id) {
    const wrap = el('div', { className: 'setting' });
    let open = false;
    const render = () => {
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
      const add = el('button', { type: 'button', className: 'button', id, text: open ? 'Done adding' : 'Add photos to the gallery', 'aria-expanded': String(open) });
      add.addEventListener('click', () => {
        open = !open;
        render();
      });
      const parts = [el('h4', { text: `My gallery photos (${gallery.photos.length})` })];
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

  const currentMode = () => document.documentElement.getAttribute('data-color-mode') || 'light';

  function renderDesign() {
    // The same color rules as the server (api/lib/palette.js, loaded from /api/admin/palette.js).
    const palette = window.FHPalette;
    if (!palette) return el('p', { className: 'result-bad', text: 'The design tools could not load. Reload the page to try again.' });
    const { onPrimary, contrastChecks, deriveDark, footerBackground, HEX } = palette;
    const t = contentState.theme;
    const options = contentMeta.design;
    const wrap = el('div', {});
    const sample = el('div', { className: 'design-sample' });
    const report = el('div', { className: 'contrast-report', role: 'status', 'aria-live': 'polite' });
    const darkReport = el('div', { className: 'contrast-report', role: 'status', 'aria-live': 'polite' });
    const darkOn = () => t.darkMode !== 'off';
    let sampleMode = darkOn() && currentMode() === 'dark' ? 'dark' : 'light';
    const validColors = (colors) => Boolean(colors) && Object.values(colors).every((v) => HEX.test(v));
    // The dark palette in use: chosen by hand, or made automatically from the light colors.
    const darkColors = () => t.darkColors || (validColors(t.colors) ? deriveDark(t.colors) : null);

    const fontStack = (list, key) => (list.find((f) => f.key === key) || list[0]).stack;
    const sampleButtons = ['light', 'dark'].map((mode) => {
      const button = el('button', { type: 'button', className: 'button small', text: mode === 'light' ? 'Light' : 'Dark' });
      button.addEventListener('click', () => {
        sampleMode = mode;
        paintSample();
      });
      return button;
    });

    function paintSample() {
      if (!darkOn()) sampleMode = 'light';
      sampleButtons.forEach((button, i) => {
        button.setAttribute('aria-pressed', String((i === 1) === (sampleMode === 'dark')));
        button.disabled = i === 1 && !darkOn();
      });
      const dark = sampleMode === 'dark';
      const c = dark ? darkColors() : t.colors;
      if (!validColors(c)) return;
      const set = (name, value) => sample.style.setProperty(name, value);
      set('--s-bg', c.background); set('--s-surface', c.surface); set('--s-tint', c.tint); set('--s-soft', c.accentSoft);
      set('--s-primary', c.primary); set('--s-dark', c.primaryDark); set('--s-text', c.text); set('--s-text-soft', c.textSoft);
      set('--s-on-primary', onPrimary(c, dark));
      set('--s-footer-bg', dark ? footerBackground(c) : c.text);
      set('--s-footer-text', dark ? c.text : c.background);
      set('--s-footer-link', dark ? c.primaryDark : c.accentSoft);
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

    function fillReport(node, colors, dark, automatic) {
      if (!validColors(colors)) {
        node.replaceChildren(el('p', { className: 'result-bad', text: 'Some colors are not valid yet.' }));
        return;
      }
      const checks = contrastChecks(colors, dark);
      const failing = checks.filter((c) => c.ratio < c.min);
      const warn = checks.filter((c) => c.ratio >= c.min && c.recommended && c.ratio < c.recommended);
      const summary = failing.length
        ? el('p', { className: 'result-bad', text: `${failing.length} combination${failing.length === 1 ? ' is' : 's are'} too hard to read. Saving is blocked until fixed.` })
        : warn.length
          ? el('p', { className: 'notice', text: 'Readable. The buttons pass the minimum, but a little more contrast would help people with low vision.' })
          : el('p', { className: 'result-ok', text: automatic ? 'Made automatically from your colors, and easy to read.' : 'All text is easy to read (meets the WCAG AA accessibility standard).' });
      const details = el('details', {}, el('summary', { text: 'Show every combination' }), el('ul', { className: 'plain-list' }, checks.map((c) => {
        const kind = c.ratio < c.min ? 'bad' : c.recommended && c.ratio < c.recommended ? 'warn' : 'ok';
        return el('li', {}, pill(`${c.ratio.toFixed(2)}:1`, kind), ' ', c.label, el('span', { className: 'small-text', text: ` (needs ${c.min}:1${c.recommended ? `, ideally ${c.recommended}:1` : ''})` }));
      })));
      if (failing.length) details.open = true;
      node.replaceChildren(summary, details);
    }
    function updateReport() {
      fillReport(report, t.colors, false, false);
      if (darkOn()) fillReport(darkReport, darkColors(), true, !t.darkColors);
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

    // A color picker plus a hex box for every color of a palette.
    const colorRows = (target, prefix, labelPrefix) => options.colors.map(({ key, label }) => {
      const id = `${prefix}-${key}`;
      const picker = el('input', { type: 'color', id, 'aria-label': `${labelPrefix}${label}` });
      picker.value = target[key];
      const hex = el('input', { type: 'text', className: 'hex-input', maxlength: 7, spellcheck: 'false', 'aria-label': `${labelPrefix}${label} (hex code)` });
      hex.value = target[key];
      picker.addEventListener('input', () => {
        target[key] = picker.value.toLowerCase();
        hex.value = target[key];
        hex.removeAttribute('aria-invalid');
        changed();
      });
      hex.addEventListener('input', () => {
        const value = hex.value.trim().toLowerCase();
        const normalized = /^[0-9a-f]{6}$/.test(value) ? `#${value}` : value;
        target[key] = normalized;
        if (HEX.test(normalized)) {
          picker.value = normalized;
          hex.removeAttribute('aria-invalid');
        } else hex.setAttribute('aria-invalid', 'true');
        changed();
      });
      return el('div', { className: 'color-row' }, picker, hex, el('label', { for: id, text: label }));
    });

    const select = (id, label, list, current, onPick, describe, rerender = false) => {
      const box = el('select', { id });
      for (const item of list) {
        const option = el('option', { value: item.key, text: describe ? describe(item) : item.label });
        option.selected = item.key === current;
        box.append(option);
      }
      box.addEventListener('change', () => {
        onPick(box.value);
        if (rerender) {
          renderContentForm();
          markDirty();
        } else changed();
      });
      return el('div', { className: 'setting' }, el('label', { for: id, text: label }), box);
    };
    const shapeName = { subtle: 'Subtle', soft: 'Soft (original)', round: 'Round', square: 'Square', pill: 'Pill (original)', rounded: 'Rounded' };

    // Dark mode: on/off, then automatic colors or the admin's own.
    const darkSection = [select('design-dark-mode', 'Dark mode on the website', options.darkModes, t.darkMode, (v) => { t.darkMode = v; }, null, true)];
    if (darkOn()) {
      const choice = (value, label) => {
        const input = el('input', { type: 'radio', name: 'design-dark-colors', value });
        input.checked = (value === 'own') === Boolean(t.darkColors);
        input.addEventListener('change', () => {
          if (!input.checked) return;
          if (value === 'own') {
            const base = darkColors();
            if (!base) {
              input.checked = false;
              return;
            }
            t.darkColors = { ...base };
          } else t.darkColors = null;
          renderContentForm();
          markDirty();
        });
        return el('label', {}, input, label);
      };
      darkSection.push(
        el('div', { className: 'radio-row', role: 'radiogroup', 'aria-label': 'Dark mode colors' },
          choice('auto', 'Make dark colors automatically from my colors (recommended)'),
          choice('own', 'Choose my own dark colors')),
        t.darkColors
          ? el('div', {}, el('div', { className: 'color-grid' }, colorRows(t.darkColors, 'dark-color', 'Dark mode: ')), darkReport)
          : el('div', {}, el('p', { className: 'small-text', text: 'They change along with your colors above. Press "Dark" above the sample to see them.' }), darkReport),
      );
    } else {
      darkSection.push(el('p', { className: 'small-text', text: 'The website always shows the light colors, and the sun/moon button is hidden.' }));
    }

    wrap.append(
      el('h3', { text: 'Colors' }),
      el('p', { className: 'small-text', text: 'Start from a ready-made palette, then adjust any color.' }),
      el('div', { className: 'preset-row' }, presetButtons),
      el('div', { className: 'design-layout' },
        el('div', {}, el('div', { className: 'color-grid' }, colorRows(t.colors, 'color', '')), report),
        el('div', {}, el('div', { className: 'sample-switch' }, el('span', { className: 'small-text', text: 'Live sample:' }), sampleButtons), sample)),
      el('h3', { text: 'Dark mode' }),
      el('p', { className: 'small-text', text: 'Visitors whose phone or computer is set to dark mode see darker colors that are easier on the eyes at night. Everyone also gets a sun/moon button to switch.' }),
      ...darkSection,
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

  // ---------- Admins (owners) ----------

  // Runs a change that needs the owner's password again. Returns the response, or null if cancelled.
  async function withPassword(message, request) {
    const password = await askPassword(message);
    if (password === null) return null;
    return request(password);
  }

  function renderAdmins(users) {
    const owners = users.filter((u) => u.role === 'owner').length;
    $('admin-list').replaceChildren(...users.map((u) => {
      const result = $('admins-result');
      const run = (button, message, request, okText) => {
        button.addEventListener('click', withBusy(button, async () => {
          try {
            const data = await withPassword(message, request);
            if (!data) return;
            renderAdmins(data.users);
            setResult(result, okText(data), true);
          } catch (err) {
            setResult(result, err.message, false);
          }
        }));
        return button;
      };
      const tools = [];
      const otherRole = u.role === 'owner' ? 'editor' : 'owner';
      const lastOwner = u.role === 'owner' && owners <= 1;
      if (!lastOwner) {
        tools.push(run(el('button', { type: 'button', className: 'button small', text: u.role === 'owner' ? 'Make editor' : 'Make owner' }),
          `Make "${u.username}" ${otherRole === 'owner' ? 'an owner' : 'an editor'}?${u.you ? ' You will no longer be able to manage admins, settings or backups.' : ''}`,
          (confirmPassword) => api(`/users/${u.id}`, { method: 'PUT', body: { role: otherRole, confirmPassword } }),
          () => `"${u.username}" is now ${otherRole === 'owner' ? 'an owner' : 'an editor'}.`));
      }
      if (!u.you) {
        const passwordButton = el('button', { type: 'button', className: 'button small', text: 'Set new password' });
        passwordButton.addEventListener('click', () => {
          const input = el('input', { type: 'password', autocomplete: 'new-password', minlength: 12, 'aria-label': `New password for ${u.username}`, placeholder: 'New password (12+ characters)' });
          const save = el('button', { type: 'submit', className: 'button small primary', text: 'Save password' });
          const cancel = el('button', { type: 'button', className: 'button small', text: 'Cancel' });
          const form = el('form', { className: 'inline-password', novalidate: true }, input, save, cancel);
          cancel.addEventListener('click', () => form.remove());
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            withBusy(save, async () => {
              if (input.value.length < 12) {
                setResult(result, 'The new password must be at least 12 characters.', false);
                input.focus();
                return;
              }
              try {
                const data = await withPassword(`Set a new password for "${u.username}"? They will be signed out everywhere. Tell them the new password in person; they should change it on their Account tab.`,
                  (confirmPassword) => api(`/users/${u.id}/password`, { method: 'POST', body: { password: input.value, confirmPassword } }));
                if (!data) return;
                renderAdmins(data.users);
                setResult(result, `New password set for "${u.username}". They were signed out.`, true);
              } catch (err) {
                setResult(result, err.message, false);
              }
            })();
          });
          passwordButton.closest('li').append(form);
          input.focus();
        });
        tools.push(passwordButton);
        if (u.twoFactor) {
          tools.push(run(el('button', { type: 'button', className: 'button small', text: 'Turn off two-step sign-in' }),
            `Turn off two-step sign-in for "${u.username}"? Only do this if they lost their phone and recovery codes.`,
            (confirmPassword) => api(`/users/${u.id}/two-factor-off`, { method: 'POST', body: { confirmPassword } }),
            () => `Two-step sign-in is off for "${u.username}". They can turn it on again on their Account tab.`));
        }
        if (!lastOwner) {
          tools.push(run(el('button', { type: 'button', className: 'button small link-like danger', text: 'Remove' }),
            `Remove "${u.username}"? They will be signed out and can't sign in again.`,
            (confirmPassword) => api(`/users/${u.id}/remove`, { method: 'POST', body: { confirmPassword } }),
            () => `Removed "${u.username}".`));
        }
      }
      return el('li', { className: 'admin-row' },
        el('div', {},
          el('strong', { text: u.username }), u.you ? el('span', { className: 'muted', text: ' (you)' }) : null, ' ',
          pill(u.role === 'owner' ? 'Owner' : 'Editor', u.role === 'owner' ? 'ok' : 'neutral'), ' ',
          u.twoFactor ? pill('Two-step sign-in on', 'ok') : pill('Password only', 'warn'),
          el('div', { className: 'small-text', text: `Added ${formatTime(u.createdAt)} · last signed in ${formatTime(u.lastLoginAt)}` })),
        el('div', { className: 'item-tools wrap' }, tools));
    }));
  }

  async function loadAdmins() {
    const data = await api('/users');
    renderAdmins(data.users);
  }

  const addAdminForm = $('add-admin-form');
  const addAdminButton = addAdminForm.querySelector('button[type="submit"]');
  addAdminForm.addEventListener('submit', (event) => {
    event.preventDefault();
    withBusy(addAdminButton, async () => {
      const result = $('add-admin-result');
      const username = $('new-admin-username').value.trim();
      const password = $('new-admin-password').value;
      const role = $('new-admin-role').value;
      if (!username) return setResult(result, 'Choose a username.', false);
      if (password.length < 12) return setResult(result, 'Their first password must be at least 12 characters.', false);
      try {
        const data = await withPassword(`Add ${role === 'owner' ? 'owner' : 'editor'} "${username}"?`,
          (confirmPassword) => api('/users', { method: 'POST', body: { username, password, role, confirmPassword } }));
        if (!data) return undefined;
        addAdminForm.reset();
        renderAdmins(data.users);
        setResult(result, `Added "${username.toLowerCase()}". They can sign in now.`, true);
      } catch (err) {
        setResult(result, err.message, false);
      }
      return undefined;
    })();
  });

  // ---------- Backup (owners) ----------

  async function loadBackup() {
    const data = await api('/backup/automatic');
    $('automatic-backups').replaceChildren(...(data.backups.length
      ? data.backups.map((b) => el('li', {},
        el('a', { className: 'link', href: `/api/admin/backup/automatic/${encodeURIComponent(b.name)}`, download: true, text: `Before the restore on ${formatTime(b.createdAt)}` }),
        el('span', { className: 'small-text', text: b.createdBy ? ` · by ${b.createdBy.replace(/ \(automatic.*$/, '')}` : '' })))
      : [el('li', { className: 'muted', text: 'None yet. One is made automatically every time a backup is restored.' })]));
  }

  $('backup-download').addEventListener('click', () => {
    setResult($('backup-download-result'), 'Downloading… Keep the file somewhere private.', true);
  });

  $('restore-file').addEventListener('change', async (event) => {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = '';
    const summaryBox = $('restore-summary');
    const result = $('restore-result');
    summaryBox.replaceChildren();
    setResult(result, '', true);
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) {
      setResult(result, 'That file is too big to be a backup from this website.', false);
      return;
    }
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      setResult(result, 'That file is not a backup (it could not be read).', false);
      return;
    }
    if (!backup || backup.format !== 'frosted-harmony-backup' || !backup.contents) {
      setResult(result, 'That file is not a Frosted Harmony backup.', false);
      return;
    }
    const c = backup.contents;
    const inquiryCount = typeof c.inquiries === 'string' ? c.inquiries.split('\n').filter((l) => l.trim()).length : 0;
    const versions = c.content && Array.isArray(c.content.history) ? c.content.history.length : 0;
    const restoreButton = el('button', { type: 'button', className: 'button primary', text: 'Restore this backup' });
    summaryBox.replaceChildren(el('div', { className: 'notice' },
      el('p', {}, el('strong', { text: file.name })),
      el('p', { text: `Made ${formatTime(backup.createdAt)}${backup.createdBy ? ` by ${backup.createdBy}` : ''}. It has ${versions} published version${versions === 1 ? '' : 's'} of the page and ${inquiryCount} inquir${inquiryCount === 1 ? 'y' : 'ies'}.` }),
      el('p', { text: 'Restoring replaces the page content (draft and live), design, settings and inquiries with the ones in this file. Photos and admin accounts stay as they are.' }),
      restoreButton));
    restoreButton.addEventListener('click', withBusy(restoreButton, async () => {
      try {
        const data = await withPassword('Restore this backup? The current state is saved first, so you can undo it.', (password) => {
          setResult(result, 'Restoring…', true);
          return api('/backup/restore', { method: 'POST', body: { password, backup } });
        });
        if (!data) return;
        summaryBox.replaceChildren();
        setResult(result, `Restored the backup from ${formatTime(data.summary.createdAt)}.${data.notes.length ? ` ${data.notes.join(' ')}` : ''}`, true);
        await loadBackup().catch(() => {});
      } catch (err) {
        setResult(result, err.message, false);
      }
    }));
  });

  // ---------- Two-step sign-in (Account tab) ----------

  function showRecoveryCodes(codes, intro) {
    const list = el('ol', { className: 'recovery-codes' }, codes.map((code) => el('li', {}, el('code', { text: code }))));
    const copy = el('button', { type: 'button', className: 'button small', text: 'Copy codes' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codes.join('\n'));
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Select and copy them by hand';
      }
    });
    const done = el('button', { type: 'button', className: 'button primary', text: 'I saved them' });
    done.addEventListener('click', () => renderTwoFactor().catch((err) => setResult($('two-factor-result'), err.message, false)));
    $('two-factor-body').replaceChildren(
      el('p', { className: 'notice', text: intro }),
      el('p', { text: 'Each recovery code works once, for signing in if your phone is lost. Save them somewhere safe (a password manager, or printed and kept at home). They won\'t be shown again.' }),
      list, el('div', { className: 'actions' }, copy, done));
  }

  async function renderTwoFactor() {
    const body = $('two-factor-body');
    const result = $('two-factor-result');
    const status = await api('/account/two-factor');
    if (!status.enabled) {
      const start = el('button', { type: 'button', className: 'button primary', text: 'Turn on two-step sign-in' });
      body.replaceChildren(
        el('p', {}, pill('Off', 'warn'), ' Signing in needs only your password.'),
        el('p', { text: 'With two-step sign-in, you also type a 6-digit code from an app on your phone, so a stolen password alone isn\'t enough. Install a free authenticator app first, such as Google Authenticator, Microsoft Authenticator or 1Password.' }),
        start);
      start.addEventListener('click', withBusy(start, async () => {
        try {
          const data = await withPassword('Turn on two-step sign-in?', (password) => api('/account/two-factor/start', { method: 'POST', body: { password } }));
          if (!data) return;
          setResult(result, '', true);
          const codeInput = el('input', { id: 'two-factor-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7 });
          const confirm = el('button', { type: 'submit', className: 'button primary', text: 'Turn on' });
          const form = el('form', { className: 'two-factor-setup', novalidate: true },
            el('ol', {},
              el('li', { text: 'In the authenticator app, add an account and scan this QR code:' }),
              el('img', { className: 'qr', src: data.qr, alt: 'QR code for the authenticator app', width: 200, height: 200 }),
              el('li', {}, 'Can\'t scan it? Choose "enter a setup key" in the app and type: ', el('code', { className: 'setup-key', text: data.secret })),
              el('li', { text: 'Type the 6-digit code the app now shows:' })),
            el('label', { for: 'two-factor-code', text: 'Code from the app' }), codeInput, confirm);
          body.replaceChildren(form);
          codeInput.focus();
          form.addEventListener('submit', (submitEvent) => {
            submitEvent.preventDefault();
            withBusy(confirm, async () => {
              try {
                const done = await api('/account/two-factor/confirm', { method: 'POST', body: { code: codeInput.value } });
                showRecoveryCodes(done.recoveryCodes, `Two-step sign-in is on.${done.signedOut ? ` ${done.signedOut} other device${done.signedOut === 1 ? ' was' : 's were'} signed out.` : ''}`);
                setResult(result, '', true);
              } catch (err) {
                setResult(result, err.message, false);
                codeInput.select();
              }
            })();
          });
        } catch (err) {
          setResult(result, err.message, false);
        }
      }));
      return;
    }

    const codeInput = el('input', { id: 'two-factor-manage-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 14 });
    const renew = el('button', { type: 'button', className: 'button', text: 'Make new recovery codes' });
    const off = el('button', { type: 'button', className: 'button link-like danger', text: 'Turn off two-step sign-in' });
    body.replaceChildren(...[
      el('p', {}, pill('On', 'ok'), ` Since ${formatTime(status.enabledAt)}. ${status.recoveryCodesLeft} recovery code${status.recoveryCodesLeft === 1 ? '' : 's'} left.`),
      status.recoveryCodesLeft < 3 ? el('p', { className: 'notice', text: 'You\'re running low on recovery codes. Make new ones.' }) : null,
      el('label', { for: 'two-factor-manage-code', text: 'Current code from the app (needed for the buttons below)' }), codeInput,
      el('div', { className: 'actions' }, renew, off),
    ].filter(Boolean));
    const needCode = () => {
      if (codeInput.value.trim()) return true;
      setResult(result, 'Type the current code from your authenticator app first.', false);
      codeInput.focus();
      return false;
    };
    renew.addEventListener('click', withBusy(renew, async () => {
      if (!needCode()) return;
      try {
        const data = await withPassword('Make new recovery codes? The old ones will stop working.',
          (password) => api('/account/two-factor/recovery-codes', { method: 'POST', body: { password, code: codeInput.value } }));
        if (data) showRecoveryCodes(data.recoveryCodes, 'New recovery codes. The old ones no longer work.');
        setResult(result, '', true);
      } catch (err) {
        setResult(result, err.message, false);
      }
    }));
    off.addEventListener('click', withBusy(off, async () => {
      if (!needCode()) return;
      try {
        const data = await withPassword('Turn off two-step sign-in? Signing in will need only your password.',
          (password) => api('/account/two-factor/disable', { method: 'POST', body: { password, code: codeInput.value } }));
        if (!data) return;
        await renderTwoFactor();
        setResult(result, 'Two-step sign-in is off.', true);
      } catch (err) {
        setResult(result, err.message, false);
      }
    }));
  }

  // ---------- Account ----------

  async function loadAccount() {
    renderTwoFactor().catch((err) => setResult($('two-factor-result'), err.message, false));
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
