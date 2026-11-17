'use strict';

// Append-only record of admin activity (who, what, when). Never pass secrets in `details`.

const fsp = require('node:fs/promises');
const { appendLine } = require('./store');

const TAIL_BYTES = 64 * 1024;

function createAudit(file) {
  async function record(action, { user = null, ip = null, details = {} } = {}) {
    const entry = { at: new Date().toISOString(), action, user, ip, ...(Object.keys(details).length ? { details } : {}) };
    await appendLine(file, JSON.stringify(entry));
  }

  async function recent(limit = 10) {
    let handle;
    try {
      handle = await fsp.open(file, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n').filter(Boolean);
      if (start > 0) lines.shift(); // First line may be cut off.
      return lines.slice(-limit).reverse().map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    } finally {
      if (handle) await handle.close();
    }
  }

  return { record, recent };
}

module.exports = { createAudit };
