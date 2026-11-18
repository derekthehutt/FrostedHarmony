'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const semver = require('../lib/semver-lite');
const { createVulnerabilityScanner, readLock, topLevelFor } = require('../lib/vulnerabilities');
const { createGithubActions } = require('../lib/github-actions');
const { inputs, fixed, remainingAdvisories } = require('../scripts/fix-vulnerability');

// ---------- Versions ----------

test('versions compare like npm, pre-releases first', () => {
  assert.equal(semver.compare('1.2.3', '1.2.10'), -1);
  assert.equal(semver.compare('2.0.0', '1.99.99'), 1);
  assert.equal(semver.compare('1.0.0-beta.2', '1.0.0'), -1);
  assert.equal(semver.compare('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(semver.compare('v1.0.0', '1.0.0'), 0);
  assert.equal(semver.valid('1.2'), false);
});

test('advisory ranges are understood, and unreadable ranges count as affected', () => {
  const cases = [
    ['9.0.0', '<=9.0.0', true], ['9.0.1', '<= 9.0.0', false], ['1.4.0', '>=1.0.0 <1.2.3 || >=1.3.0 <1.4.1', true],
    ['1.2.5', '>=1.0.0 <1.2.3 || >=1.3.0 <1.4.1', false], ['2.0.0', '>=2.0.0-alpha <2.0.1', true], ['3.1.4', '<3.1', false],
    ['3.0.9', '<=3.0', true], ['3.1.0', '<=3.0', false], ['1.5.0', '1.5', true], ['1.6.0', '1.5', false], ['4.0.0', '*', true],
    ['4.0.0', 'something odd', true],
    // GitHub's comma style and npm hyphen ranges.
    ['1.1.0', '>= 2.0.0, < 2.1.1', false], ['2.0.5', '>= 2.0.0, < 2.1.1', true],
    ['1.1.0', '1.0.0 - 1.2.3', true], ['1.2.4', '1.0.0 - 1.2.3', false], ['1.2.9', '1.0.0 - 1.2', true],
  ];
  for (const [version, range, expected] of cases) assert.equal(semver.satisfies(version, range), expected, `${version} in "${range}"`);
});

// ---------- Scanning ----------

const LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { mailer: '^1.0.0', images: '^2.0.0' } },
    'node_modules/mailer': { version: '1.0.0', dependencies: { tiny: '^0.1.0' } },
    'node_modules/images': { version: '2.0.0', dependencies: { tiny: '^0.2.0' } },
    'node_modules/tiny': { version: '0.1.0' },
    'node_modules/images/node_modules/tiny': { version: '0.2.0' },
    'node_modules/testing-tool': { version: '5.0.0', dev: true },
  },
};

test('the lock file gives installed versions, without development tools, and what brings each in', () => {
  const info = readLock(LOCK);
  assert.deepEqual([...info.packages.keys()].sort(), ['images', 'mailer', 'tiny']);
  assert.deepEqual([...info.packages.get('tiny')].sort(), ['0.1.0', '0.2.0']);
  assert.deepEqual(topLevelFor('tiny', info), ['images', 'mailer']);
  assert.deepEqual(topLevelFor('mailer', info), ['mailer']);
  assert.throws(() => readLock({ lockfileVersion: 1, dependencies: {} }), /lockfile version 2/);
});

function fakeNetwork({ bulk, advisories = {}, fail = false }) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (fail) throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    if (String(url).includes('/advisories/bulk')) return { ok: true, status: 200, json: async () => bulk };
    const id = String(url).split('/').pop();
    if (advisories[id]) return { ok: true, status: 200, json: async () => advisories[id] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

function scannerWith(network, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-security-'));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(LOCK));
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const scanner = createVulnerabilityScanner({ file: path.join(dir, 'vulnerabilities.json'), lockFile: path.join(dir, 'package-lock.json'), fetchImpl: network.fetchImpl, now: () => clock, ...extra });
  return { dir, scanner, tick: (ms) => { clock += ms; } };
}

const BULK = {
  mailer: [{ id: 1, url: 'https://github.com/advisories/GHSA-2222-3333-4444', title: 'Header injection', severity: 'high', vulnerable_versions: '<1.0.5', cvss: { score: 7.5 } }],
  tiny: [
    { id: 2, url: 'https://github.com/advisories/GHSA-5555-6666-7777', title: 'Prototype pollution', severity: 'moderate', vulnerable_versions: '<0.1.3' },
    { id: 4, url: 'https://evil.example/<script>', title: 'Bad url', severity: 'critical', vulnerable_versions: '*' },
  ],
  unknown: [{ id: 5, url: 'https://github.com/advisories/GHSA-2222-3333-5555', title: 'Not installed', severity: 'high', vulnerable_versions: '*' }],
};
const ADVISORIES = {
  'GHSA-2222-3333-4444': { cve_id: 'CVE-2026-12345', vulnerabilities: [{ package: { ecosystem: 'npm', name: 'mailer' }, vulnerable_version_range: '< 1.0.5', first_patched_version: '1.0.5' }] },
  'GHSA-5555-6666-7777': {
    cve_id: null,
    vulnerabilities: [
      { package: { ecosystem: 'npm', name: 'tiny' }, vulnerable_version_range: '< 0.1.3', first_patched_version: '0.1.3' },
      { package: { ecosystem: 'npm', name: 'tiny' }, vulnerable_version_range: '>= 0.2.0 < 0.2.4', first_patched_version: '0.2.4' },
    ],
  },
};

test('a scan lists each affected package with its CVE, severity, fixed version and how it is used', async () => {
  const network = fakeNetwork({ bulk: BULK, advisories: ADVISORIES });
  const { scanner } = scannerWith(network);
  const result = await scanner.scan({ force: true });
  assert.equal(result.ok, true);
  assert.equal(result.packages, 3);
  const sent = JSON.parse(network.calls[0].options.body);
  assert.deepEqual(sent.tiny.sort(), ['0.1.0', '0.2.0'], 'every installed version is checked');
  assert.equal(sent['testing-tool'], undefined, 'development tools are not checked');

  assert.deepEqual(result.findings.map((f) => `${f.severity} ${f.package} ${f.cve || f.id}`), [
    'high mailer CVE-2026-12345', 'moderate tiny GHSA-5555-6666-7777',
  ], 'sorted by severity; bad links and packages that are not installed are ignored');
  const [mailer, tiny] = result.findings;
  assert.equal(mailer.fixedVersion, '1.0.5');
  assert.equal(mailer.direct, true);
  assert.equal(mailer.score, 7.5);
  assert.equal(mailer.url, 'https://github.com/advisories/GHSA-2222-3333-4444');
  assert.deepEqual(tiny.installed, ['0.1.0'], 'only the affected copy');
  assert.equal(tiny.fixedVersion, '0.1.3', 'the fix for the installed version line');
  assert.deepEqual(tiny.via, ['images', 'mailer']);
  assert.equal(result.counts.high, 1);
  assert.equal(scanner.fixTarget('mailer'), '1.0.5');
});

test('problems count as reported only once emailed or seen on screen; details are cached for a week', async () => {
  const network = fakeNetwork({ bulk: BULK, advisories: ADVISORIES });
  const { scanner, tick, dir } = scannerWith(network);
  const first = await scanner.scan({ force: true });
  assert.equal(first.newFindings.length, 2);
  const githubCalls = () => network.calls.filter((c) => c.url.startsWith('https://api.github.com/')).length;
  assert.equal(githubCalls(), 2);
  tick(60_000);
  // The email failed (markNotified not called), so the next scan reports them again.
  assert.equal((await scanner.scan({ force: true })).newFindings.length, 2);
  await scanner.markNotified(first.newFindings.slice(0, 1));
  tick(60_000);
  assert.deepEqual((await scanner.scan({ force: true })).newFindings.map((f) => f.package), ['tiny']);
  tick(60_000);
  await scanner.scan({ force: true, markSeen: true });
  tick(60_000);
  const second = await scanner.scan({ force: true });
  assert.equal(second.newFindings.length, 0);
  assert.equal(githubCalls(), 2, 'cached');

  // After a restart the scanner remembers what it reported.
  const again = createVulnerabilityScanner({ file: path.join(dir, 'vulnerabilities.json'), lockFile: path.join(dir, 'package-lock.json'), fetchImpl: network.fetchImpl });
  await again.load();
  assert.equal(again.state().findings.length, 2);
  assert.equal((await again.scan({ force: true })).newFindings.length, 0);

  // A fixed problem that comes back is reported again.
  const fixedNetwork = fakeNetwork({ bulk: { mailer: BULK.mailer }, advisories: ADVISORIES });
  const later = createVulnerabilityScanner({ file: path.join(dir, 'vulnerabilities.json'), lockFile: path.join(dir, 'package-lock.json'), fetchImpl: fixedNetwork.fetchImpl });
  await later.load();
  await later.scan({ force: true });
  const back = createVulnerabilityScanner({ file: path.join(dir, 'vulnerabilities.json'), lockFile: path.join(dir, 'package-lock.json'), fetchImpl: network.fetchImpl });
  await back.load();
  assert.deepEqual((await back.scan({ force: true })).newFindings.map((f) => f.package), ['tiny']);
});

test('scans are not repeated within 30 seconds, and failures are reported, not thrown', async () => {
  const { scanner } = scannerWith(fakeNetwork({ bulk: {}, advisories: {} }));
  await scanner.scan();
  assert.equal((await scanner.scan()).skipped, true);
  const offline = scannerWith(fakeNetwork({ fail: true })).scanner;
  const failed = await offline.scan({ force: true });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /ENOTFOUND/);
});

test('the GitHub token, when set, is used for advisory details', async () => {
  const network = fakeNetwork({ bulk: BULK, advisories: ADVISORIES });
  const { scanner } = scannerWith(network, { githubToken: () => 'github_pat_test' });
  await scanner.scan({ force: true });
  const github = network.calls.find((c) => c.url.startsWith('https://api.github.com/'));
  assert.equal(github.options.headers.Authorization, 'Bearer github_pat_test');
  assert.equal(network.calls[0].options.headers.Authorization, undefined, 'never sent to npm');
});

// ---------- GitHub Actions ----------

test('the Update button starts the workflow with the package, fixed version and advisory', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/dispatches')) return { ok: true, status: 204, json: async () => null };
    return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: 7, display_title: 'Fix mailer GHSA-2222-3333-4444', status: 'completed', conclusion: 'success', created_at: '2026-11-18T12:00:00Z', html_url: 'https://github.com/derek/site/actions/runs/7' }, { id: 8, status: 'queued', html_url: 'javascript:alert(1)' }] }) };
  };
  const gh = createGithubActions({ repo: () => 'derek/site', token: () => 'github_pat_test', fetchImpl });
  const links = await gh.requestFix({ package: 'mailer', version: '1.0.5', advisory: 'GHSA-2222-3333-4444' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/derek/site/actions/workflows/fix-vulnerability.yml/dispatches');
  assert.deepEqual(JSON.parse(calls[0].options.body), { ref: 'main', inputs: { package: 'mailer', version: '1.0.5', advisory: 'GHSA-2222-3333-4444' } });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer github_pat_test');
  assert.equal(links.runsUrl, 'https://github.com/derek/site/actions/workflows/fix-vulnerability.yml');
  const runs = await gh.recentRuns();
  assert.equal(runs[0].conclusion, 'success');
  assert.equal(runs[1].url, null, 'only github.com links are passed on');
  await assert.rejects(gh.requestFix({ package: '../evil' }), /Invalid package name/);
});

test('GitHub problems are explained', async () => {
  const notSetUp = createGithubActions({ repo: () => 'derek/site', token: () => '', fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(notSetUp.configured(), false);
  await assert.rejects(notSetUp.requestFix({ package: 'mailer' }), /not set up yet/);
  for (const [status, message] of [[401, /rejected the token/], [403, /Actions: Read and write/], [404, /could not find the repository/]]) {
    const gh = createGithubActions({ repo: () => 'derek/site', token: () => 't', fetchImpl: async () => ({ ok: false, status, json: async () => ({ message: 'Bad credentials' }) }) });
    await assert.rejects(gh.requestFix({ package: 'mailer' }), message);
  }
});

// ---------- The update script ----------

test('the update script checks its inputs before running npm', () => {
  assert.deepEqual(inputs({ PKG: 'nodemailer', VERSION: '9.1.0', ADVISORY: 'GHSA-p6gq-j5cr-w38f' }).problems, []);
  assert.deepEqual(inputs({ PKG: '@img/sharp-linux-x64', VERSION: '' }).problems, []);
  for (const env of [{ PKG: 'x; rm -rf /' }, { PKG: 'ok', VERSION: '$(id)' }, { PKG: 'ok', ADVISORY: 'GHSA-1' }, { PKG: '' }, { PKG: '-x' }]) {
    assert.ok(inputs(env).problems.length, JSON.stringify(env));
  }
  assert.equal(fixed(['9.1.1'], '9.1.0'), true);
  assert.equal(fixed(['9.1.1', '8.0.0'], '9.1.0'), false, 'every installed copy must be fixed');
  assert.equal(fixed([], '1.0.0'), false);
  assert.equal(fixed(['2.0.0'], ''), true);
});

test('the update target is left to "newest" when any fix for the package is unknown', async () => {
  const advisories = { 'GHSA-2222-3333-4444': ADVISORIES['GHSA-2222-3333-4444'] };
  const bulk = { mailer: [...BULK.mailer, { id: 6, url: 'https://github.com/advisories/GHSA-2222-3333-6666', title: 'No fix known', severity: 'low', vulnerable_versions: '*' }] };
  const { scanner } = scannerWith(fakeNetwork({ bulk, advisories }));
  await scanner.scan({ force: true });
  assert.equal(scanner.finding('GHSA-2222-3333-6666', 'mailer').fixedVersion, null);
  assert.equal(scanner.fixTarget('mailer'), '', 'not 1.0.5, which would leave the other advisory open');
  assert.equal(scanner.fixTarget('nothing-here'), '');
});

test('after an update the script asks npm which advisories still apply', async () => {
  const network = fakeNetwork({ bulk: { mailer: [{ url: 'https://github.com/advisories/GHSA-2222-3333-6666', title: 'Still here' }, { url: 'https://evil.example/x' }] } });
  const remaining = await remainingAdvisories('mailer', ['1.0.5'], network.fetchImpl);
  assert.deepEqual(remaining, [{ id: 'GHSA-2222-3333-6666', title: 'Still here' }]);
  assert.deepEqual(JSON.parse(network.calls[0].options.body), { mailer: ['1.0.5'] });
  await assert.rejects(remainingAdvisories('mailer', ['1.0.5'], fakeNetwork({ fail: true }).fetchImpl), /ENOTFOUND/);
});