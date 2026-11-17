'use strict';

// Admin users, sign-in, sessions and CSRF protection.
// Passwords are stored as scrypt hashes. Session cookies hold a random token; the server keeps
// only its SHA-256 hash, so a copied sessions.json cannot be used to sign in.

const path = require('node:path');
const fsp = require('node:fs/promises');
const { readJson, writeJson } = require('./store');
const {
  DEFAULT_SCRYPT, hashPassword, verifyPassword, passwordProblem, randomToken, sha256, safeEqual,
} = require('./crypto');

const MINUTE = 60 * 1000;
const LIMITS = {
  idleMs: 30 * MINUTE,
  absoluteMs: 12 * 60 * MINUTE,
  ipFailures: 5,
  ipWindowMs: 15 * MINUTE,
  accountFailures: 10,
  accountLockMs: 15 * MINUTE,
  minLoginMs: 400,
  touchPersistMs: MINUTE,
};
const USERNAME = /^[a-z0-9._-]{3,32}$/;
const GENERIC_LOGIN_ERROR = 'Sign-in failed. Check your username and password.';

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!(name in cookies)) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

function createAuth({ dir, secureCookies = true, scryptParams = DEFAULT_SCRYPT, now = () => Date.now(), limits = {} }) {
  const usersFile = path.join(dir, 'users.json');
  const sessionsFile = path.join(dir, 'sessions.json');
  const config = { ...LIMITS, ...limits };
  // __Host- cookies must be Secure, Path=/ and have no Domain, which stops subdomains from setting them.
  const cookieName = secureCookies ? '__Host-fh_admin' : 'fh_admin';
  let users = [];
  let sessions = new Map();
  const ipFailures = new Map();
  let dummyHash = null;
  let lastSessionPersist = 0;
  // Last modification time seen for each file. The SSH create-admin script runs as a separate
  // process, so the server re-reads a file whenever it was changed by someone else.
  const seen = { users: null, sessions: null };
  // While this process has a write queued or running, the file on disk is about to be replaced
  // by our own newer data, so it must not be reloaded.
  const pending = { users: 0, sessions: 0 };
  let syncing = null;

  async function mtime(file) {
    try {
      return (await fsp.stat(file)).mtimeMs;
    } catch {
      return 0;
    }
  }

  async function reload(kind, file, apply) {
    if (pending[kind]) return;
    const time = await mtime(file);
    if (time === seen[kind] || pending[kind]) return;
    const data = await readJson(file, null);
    if (pending[kind]) return; // We started writing while reading; our data is newer.
    apply(data);
    seen[kind] = time;
  }

  async function syncNow() {
    await reload('users', usersFile, (data) => {
      users = (data && data.users) || [];
    });
    await reload('sessions', sessionsFile, (data) => {
      sessions = new Map(((data && data.sessions) || []).map((s) => [s.idHash, s]));
    });
  }

  // Only one reload at a time, so an older read can never overwrite a newer one.
  function sync() {
    if (!syncing) syncing = syncNow().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  async function load() {
    seen.users = null;
    seen.sessions = null;
    await sync();
    pruneSessions();
  }

  async function save(kind, file, data) {
    pending[kind] += 1;
    try {
      seen[kind] = await writeJson(file, data);
    } finally {
      pending[kind] -= 1;
    }
  }

  const saveUsers = () => save('users', usersFile, { version: 1, users });
  const saveSessions = () => {
    lastSessionPersist = now();
    return save('sessions', sessionsFile, { version: 1, sessions: [...sessions.values()] });
  };

  const publicUser = (user) => ({ id: user.id, username: user.username, createdAt: user.createdAt, passwordChangedAt: user.passwordChangedAt });
  const findUser = (username) => users.find((u) => u.username === String(username || '').trim().toLowerCase());
  const hasUsers = () => users.length > 0;

  async function createUser(username, password) {
    await sync();
    const name = String(username || '').trim().toLowerCase();
    if (!USERNAME.test(name)) throw new Error('Username must be 3-32 characters: letters, numbers, dot, dash or underscore.');
    if (findUser(name)) throw new Error(`User "${name}" already exists.`);
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const at = new Date(now()).toISOString();
    const user = {
      id: randomToken(9), username: name, passwordHash: await hashPassword(password, scryptParams),
      createdAt: at, passwordChangedAt: at, failedLogins: 0, lockedUntil: 0,
    };
    users.push(user);
    await saveUsers();
    return publicUser(user);
  }

  // Used by the SSH recovery script: sets a new password, unlocks the account and signs out everywhere.
  async function resetPassword(username, password) {
    await sync();
    const user = findUser(username);
    if (!user) throw new Error(`No user named "${username}".`);
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    user.passwordHash = await hashPassword(password, scryptParams);
    user.passwordChangedAt = new Date(now()).toISOString();
    user.failedLogins = 0;
    user.lockedUntil = 0;
    await saveUsers();
    await revokeSessions((s) => s.userId === user.id);
    return publicUser(user);
  }

  function recentIpFailures(ip) {
    const cutoff = now() - config.ipWindowMs;
    const hits = (ipFailures.get(ip) || []).filter((t) => t > cutoff);
    if (hits.length) ipFailures.set(ip, hits);
    else ipFailures.delete(ip);
    return hits;
  }

  async function login(username, password, { ip = 'unknown', userAgent = '' } = {}) {
    const started = now();
    const startedReal = Date.now();
    const finish = async (result) => {
      // Same minimum duration for every outcome, so timing doesn't reveal which usernames exist.
      const wait = config.minLoginMs - (Date.now() - startedReal);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      return result;
    };

    if (recentIpFailures(ip).length >= config.ipFailures) {
      return finish({ ok: false, status: 429, reason: 'ip-limited', error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
    }
    // Count the attempt before the slow password check, so parallel requests can't all slip
    // past the limit. A successful sign-in clears the IP's list below.
    ipFailures.set(ip, [...recentIpFailures(ip), now()]);

    await sync();
    const found = findUser(username);
    if (!dummyHash) dummyHash = await hashPassword(randomToken(), scryptParams);
    const passwordOk = await verifyPassword(String(password || ''), found ? found.passwordHash : dummyHash);
    // Look the user up again: the files may have been reloaded while the password was checked.
    const user = found && users.find((u) => u.id === found.id && u.passwordHash === found.passwordHash);
    const locked = user && user.lockedUntil > started;

    if (!user || !passwordOk || locked) {
      let reason = found ? 'bad-password' : 'unknown-user';
      if (locked) reason = 'locked';
      else if (user) {
        user.failedLogins = (user.failedLogins || 0) + 1;
        if (user.failedLogins >= config.accountFailures) {
          user.lockedUntil = now() + config.accountLockMs;
          user.failedLogins = 0;
          reason = 'locked-now';
        }
        await saveUsers();
      }
      return finish({ ok: false, status: 401, reason, username: found ? found.username : null, error: GENERIC_LOGIN_ERROR });
    }

    if (user.failedLogins || user.lockedUntil) {
      user.failedLogins = 0;
      user.lockedUntil = 0;
      await saveUsers();
    }
    ipFailures.delete(ip);
    const token = randomToken(32);
    const session = {
      idHash: sha256(token), userId: user.id, csrf: randomToken(24), createdAt: now(), lastSeen: now(),
      ip: String(ip).slice(0, 64), userAgent: String(userAgent).slice(0, 200),
    };
    sessions.set(session.idHash, session);
    await saveSessions();
    return finish({ ok: true, token, csrf: session.csrf, user: publicUser(user), session });
  }

  function isExpired(session) {
    const t = now();
    return t - session.lastSeen > config.idleMs || t - session.createdAt > config.absoluteMs;
  }

  function pruneSessions() {
    let removed = false;
    for (const [idHash, session] of sessions) {
      if (isExpired(session) || !users.some((u) => u.id === session.userId)) {
        sessions.delete(idHash);
        removed = true;
      }
    }
    return removed;
  }

  async function authenticate(cookieHeader) {
    const token = parseCookies(cookieHeader)[cookieName];
    if (!token || token.length > 100) return null;
    await sync();
    const idHash = sha256(token);
    const session = sessions.get(idHash);
    if (!session) return null;
    const user = users.find((u) => u.id === session.userId);
    if (!user || isExpired(session)) {
      sessions.delete(idHash);
      await saveSessions();
      return null;
    }
    session.lastSeen = now();
    if (now() - lastSessionPersist > config.touchPersistMs) await saveSessions();
    return { session, user: publicUser(user) };
  }

  const checkCsrf = (session, header) => Boolean(header) && safeEqual(header, session.csrf);

  async function revokeSessions(predicate) {
    await sync();
    let removed = 0;
    for (const [idHash, session] of sessions) {
      if (predicate(session)) {
        sessions.delete(idHash);
        removed += 1;
      }
    }
    if (removed) await saveSessions();
    return removed;
  }

  const logout = (session) => revokeSessions((s) => s.idHash === session.idHash);
  const revokeOtherSessions = (session) => revokeSessions((s) => s.userId === session.userId && s.idHash !== session.idHash);

  function listSessions(session) {
    return [...sessions.values()]
      .filter((s) => s.userId === session.userId && !isExpired(s))
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((s) => ({
        current: s.idHash === session.idHash, createdAt: new Date(s.createdAt).toISOString(),
        lastSeen: new Date(s.lastSeen).toISOString(), ip: s.ip, userAgent: s.userAgent,
      }));
  }

  async function changePassword(session, currentPassword, newPassword) {
    await sync();
    const before = users.find((u) => u.id === session.userId);
    if (!before || !(await verifyPassword(String(currentPassword || ''), before.passwordHash))) {
      return { ok: false, status: 400, error: 'Current password is incorrect.' };
    }
    const problem = passwordProblem(newPassword);
    if (problem) return { ok: false, status: 400, error: problem };
    if (await verifyPassword(newPassword, before.passwordHash)) {
      return { ok: false, status: 400, error: 'Choose a password different from the current one.' };
    }
    const newHash = await hashPassword(newPassword, scryptParams);
    // Re-read in case the account was reset over SSH while the passwords were being checked.
    await sync();
    const user = users.find((u) => u.id === session.userId && u.passwordHash === before.passwordHash);
    if (!user) return { ok: false, status: 409, error: 'Your password was changed elsewhere. Sign in again.' };
    user.passwordHash = newHash;
    user.passwordChangedAt = new Date(now()).toISOString();
    await saveUsers();
    const signedOut = await revokeOtherSessions(session);
    return { ok: true, signedOut };
  }

  function sessionCookie(token) {
    const attrs = [`${cookieName}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(config.absoluteMs / 1000)}`];
    if (secureCookies) attrs.push('Secure');
    return attrs.join('; ');
  }

  function clearCookie() {
    const attrs = [`${cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (secureCookies) attrs.push('Secure');
    return attrs.join('; ');
  }

  async function sweep() {
    await sync();
    if (pruneSessions()) await saveSessions();
    for (const ip of [...ipFailures.keys()]) recentIpFailures(ip);
  }

  return {
    load, sync, hasUsers, createUser, resetPassword, login, authenticate, checkCsrf, logout, revokeOtherSessions,
    listSessions, changePassword, sessionCookie, clearCookie, sweep, cookieName, listUsers: () => users.map(publicUser),
  };
}

module.exports = { createAuth, parseCookies, LIMITS, GENERIC_LOGIN_ERROR };
