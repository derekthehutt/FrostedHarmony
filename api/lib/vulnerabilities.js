'use strict';

// Checks the npm packages the API runs on for known vulnerabilities: the exact versions from
// package-lock.json are sent to npm's advisory service (the same data `npm audit` uses, from the
// GitHub Advisory Database), and each advisory's CVE number and first fixed version come from
// GitHub. Results are kept in /data/admin/vulnerabilities.json.

const fsp = require('node:fs/promises');
const { readJson, writeJson } = require('./store');
const semver = require('./semver-lite');

const BULK_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const ADVISORY_URL = 'https://api.github.com/advisories/';
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];
// Advisory details rarely change; refreshed weekly so GitHub's limit for anonymous requests
// (60 an hour) is never reached by the daily scan.
const DETAILS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 20_000;
const MIN_SCAN_GAP_MS = 30_000;
const findingKey = (f) => `${f.id}:${f.package}`;

// Installed packages from package-lock.json (lockfile version 2 or 3), without development tools.
// Returns { packages: Map(name -> Set(versions)), direct: Set(names), dependents: Map(name -> Set(names)) }.
function readLock(lock) {
  const entries = lock && lock.packages && typeof lock.packages === 'object' ? lock.packages : null;
  if (!entries) throw new Error('package-lock.json is missing or too old (lockfile version 2 or newer is needed).');
  const root = entries[''] || {};
  const direct = new Set(Object.keys(root.dependencies || {}));
  const packages = new Map();
  const dependents = new Map();
  for (const [key, info] of Object.entries(entries)) {
    if (!key || !info || info.dev || info.link || typeof info.version !== 'string') continue;
    const name = info.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!packages.has(name)) packages.set(name, new Set());
    packages.get(name).add(info.version);
    for (const dep of [...Object.keys(info.dependencies || {}), ...Object.keys(info.optionalDependencies || {})]) {
      if (!dependents.has(dep)) dependents.set(dep, new Set());
      dependents.get(dep).add(name);
    }
  }
  return { packages, direct, dependents };
}

// The direct dependencies (in package.json) that bring a package in.
function topLevelFor(name, lockInfo) {
  if (lockInfo.direct.has(name)) return [name];
  const found = new Set();
  const seen = new Set([name]);
  const queue = [name];
  while (queue.length) {
    const current = queue.shift();
    for (const parent of lockInfo.dependents.get(current) || []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (lockInfo.direct.has(parent)) found.add(parent);
      else queue.push(parent);
    }
  }
  return [...found].sort();
}

function createVulnerabilityScanner({ file, lockFile, fetchImpl = (...args) => fetch(...args), now = () => Date.now(), githubToken = () => '' }) {
  let state = { scannedAt: null, ok: null, error: null, findings: [], details: {}, notified: [] };
  let running = null;
  let lastStarted = 0;

  async function load() {
    const saved = await readJson(file, null);
    if (saved && typeof saved === 'object') state = { ...state, ...saved };
  }

  async function postJson(url, body) {
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the npm advisory service answered HTTP ${res.status}`);
    return res.json();
  }

  async function advisoryDetails(ghsa) {
    const cached = state.details[ghsa];
    if (cached && now() - cached.fetchedAt < DETAILS_MAX_AGE_MS) return cached;
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const token = githubToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetchImpl(`${ADVISORY_URL}${ghsa}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return cached || null;
      const body = await res.json();
      const details = {
        cve: typeof body.cve_id === 'string' && /^CVE-\d{4}-\d{4,}$/.test(body.cve_id) ? body.cve_id : null,
        patched: {},
        fetchedAt: now(),
      };
      for (const v of Array.isArray(body.vulnerabilities) ? body.vulnerabilities : []) {
        const name = v && v.package && v.package.ecosystem === 'npm' ? v.package.name : null;
        const fixed = v && typeof v.first_patched_version === 'string' ? v.first_patched_version : null;
        if (name && fixed && semver.valid(fixed)) {
          // An advisory can cover several version lines (for example 1.x and 2.x), each with its own fix.
          if (!details.patched[name]) details.patched[name] = [];
          details.patched[name].push({ range: String(v.vulnerable_version_range || ''), fixed });
        }
      }
      state.details[ghsa] = details;
      return details;
    } catch {
      return cached || null;
    }
  }

  // The first fixed version for the installed version's line, or the newest fix listed.
  function fixedVersionFor(details, name, installed) {
    const lines = details && details.patched[name] ? details.patched[name] : [];
    const matching = lines.find((line) => installed.some((v) => semver.satisfies(v, line.range)));
    const chosen = matching || lines.slice().sort((a, b) => semver.compare(b.fixed, a.fixed))[0];
    return chosen ? chosen.fixed : null;
  }

  async function runScan() {
    const lockInfo = readLock(JSON.parse(await fsp.readFile(lockFile, 'utf8')));
    const query = {};
    for (const [name, versions] of lockInfo.packages) query[name] = [...versions];
    const response = await postJson(BULK_URL, query);
    const findings = [];
    for (const [name, advisories] of Object.entries(response && typeof response === 'object' ? response : {})) {
      if (!lockInfo.packages.has(name) || !Array.isArray(advisories)) continue;
      const versions = [...lockInfo.packages.get(name)];
      for (const advisory of advisories) {
        const ghsa = typeof advisory.url === 'string' ? advisory.url.split('/').pop() : '';
        if (!GHSA.test(ghsa)) continue;
        // npm already matched the advisory to these versions; the range only says which copies it hits.
        const matched = versions.filter((v) => semver.satisfies(v, advisory.vulnerable_versions));
        const affected = matched.length ? matched : versions;
        const details = await advisoryDetails(ghsa);
        findings.push({
          id: ghsa,
          cve: details ? details.cve : null,
          title: String(advisory.title || '').slice(0, 300),
          severity: SEVERITIES.includes(advisory.severity) ? advisory.severity : 'moderate',
          score: advisory.cvss && Number.isFinite(advisory.cvss.score) ? advisory.cvss.score : null,
          package: name,
          installed: affected,
          vulnerableRange: String(advisory.vulnerable_versions || '').slice(0, 200),
          fixedVersion: fixedVersionFor(details, name, affected),
          direct: lockInfo.direct.has(name),
          via: topLevelFor(name, lockInfo),
          url: `https://github.com/advisories/${ghsa}`,
        });
      }
    }
    findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.package.localeCompare(b.package));
    return { findings, packages: lockInfo.packages.size };
  }

  // Returns the new state plus the findings not reported before (for the email alert). They count as
  // reported only after markNotified() (the alert email was sent) or a scan with markSeen (someone
  // pressed Scan now and saw them on screen).
  function scan({ force = false, markSeen = false } = {}) {
    if (running) return running;
    if (!force && now() - lastStarted < MIN_SCAN_GAP_MS) return Promise.resolve({ ...publicState(), newFindings: [], skipped: true });
    lastStarted = now();
    running = (async () => {
      const at = new Date(now()).toISOString();
      try {
        const { findings, packages } = await runScan();
        const known = new Set(state.notified);
        const newFindings = findings.filter((f) => !known.has(findingKey(f)));
        // Fixed problems are forgotten, so they're reported again if they ever come back.
        const current = findings.map(findingKey);
        const notified = markSeen ? current : current.filter((key) => known.has(key));
        state = { ...state, scannedAt: at, ok: true, error: null, findings, packages, notified };
        const used = new Set(findings.map((f) => f.id));
        for (const id of Object.keys(state.details)) if (!used.has(id)) delete state.details[id];
        await writeJson(file, state);
        return { ...publicState(), newFindings };
      } catch (err) {
        state = { ...state, scannedAt: at, ok: false, error: err.message || 'Scan failed.' };
        await writeJson(file, state);
        return { ...publicState(), newFindings: [] };
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function publicState() {
    return {
      scannedAt: state.scannedAt, ok: state.ok, error: state.error, packages: state.packages || null,
      findings: state.findings, counts: SEVERITIES.reduce((acc, s) => ({ ...acc, [s]: state.findings.filter((f) => f.severity === s).length }), {}),
    };
  }

  const finding = (id, name) => state.findings.find((f) => f.id === id && f.package === name) || null;

  async function markNotified(found) {
    const keys = new Set([...state.notified, ...found.map(findingKey)]);
    const current = new Set(state.findings.map(findingKey));
    state = { ...state, notified: [...keys].filter((key) => current.has(key)) };
    await writeJson(file, state);
  }

  // The version that fixes every known problem in a package, so one update covers them all. Empty
  // ("the newest version") when the fix for any of them is unknown; the GitHub Action then checks
  // npm's advisory database again before it opens a pull request.
  function fixTarget(name) {
    const forPackage = state.findings.filter((f) => f.package === name);
    if (!forPackage.length || forPackage.some((f) => !f.fixedVersion)) return '';
    return forPackage.map((f) => f.fixedVersion).sort(semver.compare).pop();
  }

  return { load, scan, markNotified, state: publicState, finding, fixTarget };
}

module.exports = { createVulnerabilityScanner, readLock, topLevelFor, GHSA, BULK_URL };
