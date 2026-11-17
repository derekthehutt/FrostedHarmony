'use strict';

// Inquiries sent with the website form, kept in inquiries.jsonl (one JSON object per line) in the
// data folder. New inquiries are appended; marking one handled or deleting it rewrites the file.
// Every change goes through one queue, so an inquiry arriving during a rewrite is never lost.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { writeFileAtomic } = require('./store');

const INQUIRY_TYPES = {
  pricing: 'Pricing',
  'custom-order': 'Custom order',
  event: 'Event or party',
  general: 'General question',
};
const VIEWS = ['open', 'handled', 'spam', 'all'];
const ID = /^[0-9a-f]{16}$/;
// Spam is deleted automatically after this long, and only the newest are kept.
const SPAM_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const SPAM_MAX = 2000;
const FILE_MODE = 0o640;
const SEARCH_FIELDS = ['name', 'email', 'phone', 'eventDate', 'quantity', 'message'];
const DELIVERY = ['pending', 'sent', 'failed', 'not-configured', 'skipped'];

const hashId = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const str = (value) => (typeof value === 'string' ? value : '');

function viewOf(entry) {
  if (entry.spam) return 'spam';
  return entry.handled ? 'handled' : 'open';
}

// What the admin portal sees. Only known fields, always strings or booleans.
function toPublic(entry) {
  const delivery = entry.delivery && DELIVERY.includes(entry.delivery.status) ? entry.delivery : null;
  return {
    id: entry.id,
    receivedAt: str(entry.receivedAt),
    name: str(entry.name),
    email: str(entry.email),
    phone: str(entry.phone),
    inquiryType: INQUIRY_TYPES[entry.inquiryType] ? entry.inquiryType : 'general',
    type: INQUIRY_TYPES[entry.inquiryType] || INQUIRY_TYPES.general,
    eventDate: str(entry.eventDate),
    quantity: str(entry.quantity),
    message: str(entry.message),
    spam: Boolean(entry.spam),
    handled: Boolean(entry.handled),
    handledAt: str(entry.handledAt) || null,
    handledBy: str(entry.handledBy) || null,
    delivery: delivery ? { status: delivery.status, at: str(delivery.at) || null, error: str(delivery.error) || null } : null,
  };
}

// Spreadsheet programs run cells that start with these characters as formulas.
function csvCell(value) {
  let text = String(value === undefined || value === null ? '' : value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const DELIVERY_LABELS = {
  pending: 'Sending', sent: 'Emailed', failed: 'Email failed', 'not-configured': 'Email not set up', skipped: 'Not emailed (spam)',
};

function createInquiryStore({ file, now = () => Date.now() }) {
  // Oldest first, exactly as on disk. Lines that can't be read are kept as-is and never shown.
  let entries = [];
  let queue = Promise.resolve();

  function run(task) {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  }

  function parse(text) {
    const result = [];
    const seen = new Set();
    let missingIds = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        raw = null;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        result.push({ broken: true, line });
        continue;
      }
      // Inquiries saved before the inbox existed have no id: derive a stable one from the line.
      let id = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : null;
      if (!id || seen.has(id)) {
        missingIds = true;
        id = hashId(line);
        while (seen.has(id)) id = hashId(`${id}${line}`);
      }
      seen.add(id);
      result.push({ ...raw, id });
    }
    return { list: result, missingIds };
  }

  async function readFile() {
    try {
      return await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return '';
      throw err;
    }
  }

  const serialize = (list) => list.map((e) => (e.broken ? e.line : JSON.stringify(e))).join('\n') + (list.length ? '\n' : '');

  async function save(list) {
    await writeFileAtomic(file, serialize(list), FILE_MODE);
    entries = list;
  }

  // Old spam is removed; returns the list to keep.
  function withoutOldSpam(list) {
    const cutoff = now() - SPAM_KEEP_MS;
    const spam = list.filter((e) => !e.broken && e.spam);
    const tooMany = new Set(spam.slice(0, Math.max(0, spam.length - SPAM_MAX)));
    return list.filter((e) => e.broken || !e.spam || (!tooMany.has(e) && Date.parse(e.receivedAt) >= cutoff));
  }

  function load() {
    return run(async () => {
      const { list, missingIds } = parse(await readFile());
      entries = list;
      const kept = withoutOldSpam(entries);
      // Old inquiries get their ids written to disk, so they stay the same from now on.
      if (missingIds || kept.length !== entries.length) await save(kept);
    });
  }

  function add(data, { spam = false, delivery = null } = {}) {
    return run(async () => {
      const entry = {
        id: crypto.randomBytes(8).toString('hex'),
        receivedAt: new Date(now()).toISOString(),
        ...(spam ? { spam: true } : {}),
        ...data,
        ...(delivery ? { delivery: { status: delivery, at: new Date(now()).toISOString() } } : {}),
      };
      await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
      entries = [...entries, entry];
      if (spam && entries.filter((e) => e.spam).length > SPAM_MAX) await save(withoutOldSpam(entries));
      return toPublic(entry);
    });
  }

  // changes: { handled?: boolean, spam?: boolean, delivery?: { status, error } }. by: admin username.
  function update(id, changes, by) {
    return run(async () => {
      const index = entries.findIndex((e) => !e.broken && e.id === id);
      if (index === -1) return null;
      const entry = { ...entries[index] };
      const at = new Date(now()).toISOString();
      if (typeof changes.handled === 'boolean') {
        if (changes.handled) Object.assign(entry, { handled: true, handledAt: at, handledBy: by || null });
        else {
          delete entry.handled;
          delete entry.handledAt;
          delete entry.handledBy;
        }
      }
      if (typeof changes.spam === 'boolean') {
        if (changes.spam) entry.spam = true;
        else delete entry.spam;
      }
      if (changes.delivery && DELIVERY.includes(changes.delivery.status)) {
        entry.delivery = { status: changes.delivery.status, at, ...(changes.delivery.error ? { error: String(changes.delivery.error).slice(0, 300) } : {}) };
      }
      const next = [...entries];
      next[index] = entry;
      await save(next);
      return toPublic(entry);
    });
  }

  function remove(id) {
    return run(async () => {
      const next = entries.filter((e) => e.broken || e.id !== id);
      if (next.length === entries.length) return false;
      await save(next);
      return true;
    });
  }

  function removeSpam() {
    return run(async () => {
      const next = entries.filter((e) => e.broken || !e.spam);
      const removed = entries.length - next.length;
      if (removed) await save(next);
      return removed;
    });
  }

  function matching({ view = 'all', q = '' } = {}) {
    const needle = String(q || '').trim().toLowerCase().slice(0, 100);
    return entries.filter((e) => !e.broken)
      .filter((e) => view === 'all' || viewOf(e) === view)
      .filter((e) => !needle || SEARCH_FIELDS.some((f) => str(e[f]).toLowerCase().includes(needle)))
      .reverse();
  }

  function counts() {
    const result = { open: 0, handled: 0, spam: 0, all: 0 };
    for (const e of entries) {
      if (e.broken) continue;
      result[viewOf(e)] += 1;
      result.all += 1;
    }
    return result;
  }

  // Newest first.
  function list({ view = 'open', q = '', offset = 0, limit = 25 } = {}) {
    const found = matching({ view: VIEWS.includes(view) ? view : 'open', q });
    const start = Math.max(0, Number.parseInt(offset, 10) || 0);
    const size = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
    return { items: found.slice(start, start + size).map(toPublic), total: found.length, counts: counts() };
  }

  function get(id) {
    const entry = entries.find((e) => !e.broken && e.id === id);
    return entry ? toPublic(entry) : null;
  }

  // Latest real inquiries for the dashboard.
  const recent = (limit) => entries.filter((e) => !e.broken && !e.spam).slice(-limit).reverse().map(toPublic);

  // A spreadsheet of the chosen view. Starts with a byte-order mark so Excel reads accents correctly.
  function csv({ view = 'all', q = '' } = {}) {
    const header = ['Received', 'Status', 'Type', 'Name', 'Email', 'Phone', 'Event date', 'Quantity', 'Message', 'Email delivery'];
    const rows = matching({ view: VIEWS.includes(view) ? view : 'all', q }).map(toPublic).map((e) => [
      e.receivedAt, e.spam ? 'Spam' : e.handled ? 'Handled' : 'Needs reply', e.type, e.name, e.email, e.phone,
      e.eventDate, e.quantity, e.message, e.delivery ? DELIVERY_LABELS[e.delivery.status] : '',
    ]);
    return `\ufeff${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }

  // Daily clean-up of old spam.
  function prune() {
    return run(async () => {
      const kept = withoutOldSpam(entries);
      if (kept.length !== entries.length) await save(kept);
    });
  }

  // Backups: the file contents as stored, and replacing them (through the same queue).
  const exportText = () => run(() => serialize(entries));
  function checkImport(text) {
    if (typeof text !== 'string') return { error: 'The backup has no inquiries.' };
    const { list } = parse(text);
    return { list, count: list.filter((e) => !e.broken).length };
  }
  const applyImport = ({ list }) => run(() => save(list));

  return { load, add, update, remove, removeSpam, prune, list, get, recent, counts, csv, exportText, checkImport, applyImport, flush: () => run(() => {}) };
}

module.exports = { createInquiryStore, INQUIRY_TYPES, VIEWS };
