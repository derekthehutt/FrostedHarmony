'use strict';

// Backups of everything the admin portal manages, except photos: settings (secrets stay
// encrypted), page content with its published versions, and inquiries. One JSON file that can be
// downloaded and later uploaded again to restore. Admin accounts are not included, so a restore
// can never bring back a removed admin or an old password.
//
// Before every restore an automatic backup of the current state is saved on the server, so a
// mistaken restore can be undone.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomic, readJson, ensurePrivateDir } = require('./store');

const FORMAT = 'frosted-harmony-backup';
const VERSION = 1;
const KEEP_AUTOMATIC = 5;
const AUTOMATIC = /^before-restore-\d{8}-\d{6}-[0-9a-f]{6}\.json$/;

const checksum = (contents) => crypto.createHash('sha256').update(JSON.stringify(contents)).digest('hex');
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function createBackups({ dir, settings, content, inquiries, siteName = () => '', now = () => Date.now() }) {
  async function build(by) {
    const contents = {
      settings: settings.exportState(),
      content: await content.exportAll(),
      inquiries: await inquiries.exportText(),
    };
    return {
      format: FORMAT, version: VERSION, site: siteName(), createdAt: new Date(now()).toISOString(), createdBy: by || null,
      contents, checksum: checksum(contents),
    };
  }

  // A backup to download. Runs inside the content queue so the page content is consistent.
  const download = (by) => content.exclusive(() => build(by));

  function summarize(backup, inquiryCount) {
    const c = backup.contents.content || {};
    return {
      createdAt: backup.createdAt, createdBy: backup.createdBy, site: backup.site,
      publishedVersions: Array.isArray(c.history) ? c.history.length : 0, inquiries: inquiryCount,
      hasLivePage: Boolean(c.published),
    };
  }

  // Checks everything first; nothing is changed unless the whole backup can be used.
  function check(backup) {
    if (!backup || typeof backup !== 'object' || backup.format !== FORMAT) {
      return { error: 'This is not a Frosted Harmony backup file.' };
    }
    if (backup.version !== VERSION) return { error: `This backup was made by a different version of the website (format ${backup.version}).` };
    if (!backup.contents || typeof backup.contents !== 'object') return { error: 'The backup file is incomplete.' };
    if (backup.checksum !== checksum(backup.contents)) {
      return { error: 'The backup file is damaged or was edited, so it can\'t be restored safely.' };
    }
    const settingsPart = settings.checkImport(backup.contents.settings);
    if (settingsPart.error) return settingsPart;
    const contentPart = content.checkImport(backup.contents.content);
    if (contentPart.error) return contentPart;
    const inquiryPart = inquiries.checkImport(backup.contents.inquiries);
    if (inquiryPart.error) return inquiryPart;
    return {
      settingsPart, contentPart, inquiryPart,
      notes: [...settingsPart.notes, ...contentPart.notes],
      summary: summarize(backup, inquiryPart.count),
    };
  }

  async function saveAutomatic(backup) {
    await ensurePrivateDir(dir);
    const name = `before-restore-${stamp(now())}-${crypto.randomBytes(3).toString('hex')}.json`;
    await writeFileAtomic(path.join(dir, name), JSON.stringify(backup), 0o600);
    const names = (await fsp.readdir(dir)).filter((n) => AUTOMATIC.test(n)).sort();
    for (const old of names.slice(0, Math.max(0, names.length - KEEP_AUTOMATIC))) await fsp.rm(path.join(dir, old), { force: true });
    return name;
  }

  async function restore(backup, by) {
    const checked = check(backup);
    if (checked.error) return { ok: false, status: 400, error: checked.error };
    return content.exclusive(async () => {
      const automatic = await saveAutomatic(await build(`${by || 'admin'} (automatic, before restoring)`));
      await content.applyImport(checked.contentPart);
      await settings.applyImport(checked.settingsPart);
      await inquiries.applyImport(checked.inquiryPart);
      return { ok: true, summary: checked.summary, notes: checked.notes, automatic };
    });
  }

  async function listAutomatic() {
    let names = [];
    try {
      names = (await fsp.readdir(dir)).filter((n) => AUTOMATIC.test(n)).sort().reverse();
    } catch {
      return [];
    }
    const list = [];
    for (const name of names) {
      const backup = await readJson(path.join(dir, name), null).catch(() => null);
      if (backup) list.push({ name, createdAt: backup.createdAt, createdBy: backup.createdBy });
    }
    return list;
  }

  async function readAutomatic(name) {
    if (typeof name !== 'string' || !AUTOMATIC.test(name)) return null;
    try {
      return await fsp.readFile(path.join(dir, name));
    } catch {
      return null;
    }
  }

  return { download, check, restore, listAutomatic, readAutomatic };
}

module.exports = { createBackups, FORMAT, VERSION };
