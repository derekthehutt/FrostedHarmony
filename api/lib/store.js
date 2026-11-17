'use strict';

// Crash-safe JSON storage: write to a temp file, flush to disk, then rename over the original.
// Writes to the same file are queued so two requests can never interleave.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const queues = new Map();

async function writeFileAtomic(file, contents, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsp.open(tmp, 'w', mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
  // Returned so callers can tell their own writes apart from changes made by another process.
  return (await fsp.stat(file)).mtimeMs;
}

function serialize(file, task) {
  const previous = queues.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(file, next);
  next.finally(() => {
    if (queues.get(file) === next) queues.delete(file);
  }).catch(() => {});
  return next;
}

function writeJson(file, data, mode = 0o600) {
  return serialize(file, () => writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, mode));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${path.basename(file)}: ${err.message}`);
  }
}

function appendLine(file, line, mode = 0o600) {
  return serialize(file, () => fsp.appendFile(file, `${line}\n`, { mode }));
}

async function ensurePrivateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir ignores mode for existing folders; tighten it anyway (no-op on Windows).
  await fsp.chmod(dir, 0o700).catch(() => {});
}

function existsSync(file) {
  return fs.existsSync(file);
}

module.exports = { writeJson, readJson, appendLine, ensurePrivateDir, writeFileAtomic, existsSync };
