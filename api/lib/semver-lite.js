'use strict';

// Just enough semantic versioning for security checks: comparing versions and testing them against
// npm advisory ranges such as ">=1.0.0 <1.2.3 || >=2.0.0 <2.1.1" or "<= 9.0.0".

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(version) {
  const m = VERSION.exec(String(version || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

const valid = (version) => parse(version) !== null;

// -1, 0 or 1. Pre-releases sort before their release (1.0.0-beta < 1.0.0).
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (const key of ['major', 'minor', 'patch']) if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const xn = /^\d+$/.test(x.pre[i]);
    const yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn && Number(x.pre[i]) !== Number(y.pre[i])) return Number(x.pre[i]) < Number(y.pre[i]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (x.pre[i] !== y.pre[i]) return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}

// Expands an incomplete version ("1.2" or "1") in a comparator to the lowest or highest it covers.
function comparatorTest(op, raw) {
  const parts = raw.replace(/^v/, '').split('.');
  const filled = () => [...parts, '0', '0'].slice(0, 3).join('.');
  if (parts.length < 3 && (op === '<=' || op === '>' || op === '' || op === '=')) {
    // "<=1.2" means "<1.3.0"; ">1.2" means ">=1.3.0"; "1.2" means ">=1.2.0 <1.3.0".
    const next = [...parts];
    next[next.length - 1] = String(Number(next[next.length - 1]) + 1);
    const upper = [...next, '0', '0'].slice(0, 3).join('.');
    if (op === '<=') return (v) => compare(v, upper) < 0;
    if (op === '>') return (v) => compare(v, upper) >= 0;
    return (v) => compare(v, filled()) >= 0 && compare(v, upper) < 0;
  }
  const target = filled();
  if (!valid(target)) return null;
  switch (op) {
    case '<': return (v) => compare(v, target) < 0;
    case '<=': return (v) => compare(v, target) <= 0;
    case '>': return (v) => compare(v, target) > 0;
    case '>=': return (v) => compare(v, target) >= 0;
    default: return (v) => compare(v, target) === 0;
  }
}

// True when the version is in the range. Unreadable ranges count as "affected", so a problem is
// never hidden because a range used syntax this file doesn't understand.
function satisfies(version, range) {
  if (!valid(version)) return true;
  // GitHub writes ranges with commas (">= 2.0.0, < 2.1.1"); npm with spaces.
  const text = String(range || '').replace(/,/g, ' ').trim();
  if (!text || text === '*') return true;
  return text.split('||').some((alternative) => {
    const tokens = alternative.trim()
      .replace(/(\S+)\s+-\s+(\S+)/g, '>=$1 <=$2') // hyphen range "1.0.0 - 1.2.3"
      .replace(/([<>]=?|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    return tokens.every((token) => {
      if (token === '*' || /^[xX]$/.test(token)) return true;
      const m = /^(<=|>=|<|>|=)?(v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/.exec(token);
      if (!m) return true;
      const test = comparatorTest(m[1] || '', m[2]);
      return test ? test(version) : true;
    });
  });
}

module.exports = { parse, valid, compare, satisfies };
