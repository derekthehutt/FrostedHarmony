'use strict';

// Admin users, sign-in, sessions and CSRF protection.
// Passwords are stored as scrypt hashes. Session cookies hold a random token; the server keeps
// only its SHA-256 hash, so a copied sessions.json cannot be used to sign in.

const path = require('node:path');
const fsp = require('node:fs/promises');
const { readJson, writeJson } = require('./store');
const {
  DEFAULT_SCRYPT, hashPassword, verifyPassword, passwordProblem, randomToken, sha256, safeEqual, encrypt, decrypt,
} = require('./crypto');
const totp = require('./totp');

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
  // Two-step sign-in: time to type the code after the password, and wrong codes allowed per try.
  ticketMs: 5 * MINUTE,
  codeAttempts: 3,
  setupMs: 10 * MINUTE,
};
const USERNAME = /^[a-z0-9._-]{3,32}$/;
const GENERIC_LOGIN_ERROR = 'Sign-in failed. Check your username and password.';
// Owners can do everything. Editors can change the page, photos and inbox, but not settings,
// admins or backups.
const ROLES = ['owner', 'editor'];
const roleOf = (user) => (user.role === 'editor' ? 'editor' : 'owner');

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

function createAuth({ dir, key = null, secureCookies = true, scryptParams = DEFAULT_SCRYPT, now = () => Date.now(), limits = {} }) {
  const usersFile = path.join(dir, 'users.json');
  const sessionsFile = path.join(dir, 'sessions.json');
  const lastLoginFile = path.join(dir, 'last-sign-in.json');
  let lastLogins = {};
  const config = { ...LIMITS, ...limits };
  // __Host- cookies must be Secure, Path=/ and have no Domain, which stops subdomains from setting them.
  const cookieName = secureCookies ? '__Host-fh_admin' : 'fh_admin';
  let users = [];
  let sessions = new Map();
  const ipFailures = new Map();
  // Sign-ins waiting for their two-step code, by hashed ticket. Kept in memory only: a restart
  // simply means typing the password again.
  const tickets = new Map();
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
    const saved = await readJson(lastLoginFile, {});
    lastLogins = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
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

  const publicUser = (user) => ({
    id: user.id, username: user.username, role: roleOf(user), twoFactor: Boolean(user.totp),
    createdAt: user.createdAt, passwordChangedAt: user.passwordChangedAt, lastLoginAt: lastLogins[user.id] || null,
  });
  const findUser = (username) => users.find((u) => u.username === String(username || '').trim().toLowerCase());
  const hasUsers = () => users.length > 0;
  const owners = () => users.filter((u) => roleOf(u) === 'owner');

  async function createUser(username, password, { role = 'owner' } = {}) {
    await sync();
    const name = String(username || '').trim().toLowerCase();
    if (!USERNAME.test(name)) throw new Error('Username must be 3-32 characters: letters, numbers, dot, dash or underscore.');
    if (!ROLES.includes(role)) throw new Error('Unknown role.');
    if (findUser(name)) throw new Error(`User "${name}" already exists.`);
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const at = new Date(now()).toISOString();
    const user = {
      id: randomToken(9), username: name, role, passwordHash: await hashPassword(password, scryptParams),
      createdAt: at, passwordChangedAt: at, failedLogins: 0, lockedUntil: 0,
    };
    // Checked again after the slow hashing, in case the same name was added meanwhile.
    await sync();
    if (findUser(name)) throw new Error(`User "${name}" already exists.`);
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

    // Two-step sign-in: the password was right, now the code from the authenticator app is needed.
    // The IP's failure list and the account's failure count are only cleared once the code is right
    // too, so knowing the password doesn't allow unlimited guessing of codes.
    if (user.totp) {
      const ticket = randomToken(32);
      tickets.set(sha256(ticket), {
        userId: user.id, passwordHash: user.passwordHash, ip: String(ip), expires: now() + config.ticketMs, attempts: 0,
      });
      return finish({ ok: false, status: 200, needsCode: true, ticket, username: user.username });
    }

    if (user.failedLogins || user.lockedUntil) {
      user.failedLogins = 0;
      user.lockedUntil = 0;
      await saveUsers();
    }
    ipFailures.delete(ip);
    return finish({ ok: true, ...(await startSession(user, ip, userAgent)) });
  }

  async function startSession(user, ip, userAgent) {
    const token = randomToken(32);
    const session = {
      idHash: sha256(token), userId: user.id, csrf: randomToken(24), createdAt: now(), lastSeen: now(),
      ip: String(ip).slice(0, 64), userAgent: String(userAgent).slice(0, 200),
    };
    sessions.set(session.idHash, session);
    await saveSessions();
    // Kept in its own file: users.json is also written by the SSH script, so the server avoids
    // writing it on every sign-in.
    lastLogins[user.id] = new Date(now()).toISOString();
    await writeJson(lastLoginFile, lastLogins);
    return { token, csrf: session.csrf, user: publicUser(user), session };
  }

  function decryptSecret(user, envelope) {
    if (!key) throw new Error('ADMIN_ENCRYPTION_KEY is not set.');
    return decrypt(key, envelope, `totp:${user.id}`);
  }

  // Checks an authenticator code or an unused recovery code, and records its use.
  // Returns 'code', 'recovery' or null. The caller saves the user.
  function useSecondFactor(user, code) {
    const typed = String(code || '').trim();
    if (/^\d{3}\s?\d{3}$/.test(typed)) {
      let secret;
      try {
        secret = decryptSecret(user, user.totp.secretEnc);
      } catch {
        return null;
      }
      const step = totp.verify(secret, typed, { now: now(), lastStep: user.totp.lastStep ?? -1 });
      if (step === null) return null;
      user.totp.lastStep = step;
      return 'code';
    }
    const hash = sha256(totp.normalizeRecoveryCode(typed));
    const index = (user.totp.recovery || []).findIndex((h) => safeEqual(h, hash));
    if (index === -1) return null;
    user.totp.recovery.splice(index, 1);
    return 'recovery';
  }

  // Second step of a sign-in with two-step sign-in turned on.
  async function completeLogin(ticket, code, { ip = 'unknown', userAgent = '' } = {}) {
    const startedReal = Date.now();
    const finish = async (result) => {
      const wait = config.minLoginMs - (Date.now() - startedReal);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      return result;
    };
    const expired = { ok: false, status: 401, reason: 'ticket', error: 'Your sign-in timed out. Enter your username and password again.' };
    if (typeof ticket !== 'string' || ticket.length > 100) return finish(expired);
    const ticketHash = sha256(ticket);
    const pendingLogin = tickets.get(ticketHash);
    if (!pendingLogin || pendingLogin.expires < now() || pendingLogin.ip !== String(ip)) {
      tickets.delete(ticketHash);
      return finish(expired);
    }
    if (recentIpFailures(ip).length >= config.ipFailures) {
      tickets.delete(ticketHash);
      return finish({ ok: false, status: 429, reason: 'ip-limited', error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
    }
    ipFailures.set(ip, [...recentIpFailures(ip), now()]);

    await sync();
    // The password must not have changed (or the account been removed) since the first step.
    const user = users.find((u) => u.id === pendingLogin.userId && u.passwordHash === pendingLogin.passwordHash);
    if (!user || !user.totp || user.lockedUntil > now()) {
      tickets.delete(ticketHash);
      return finish(expired);
    }
    const used = useSecondFactor(user, code);
    if (!used) {
      pendingLogin.attempts += 1;
      user.failedLogins = (user.failedLogins || 0) + 1;
      let reason = 'bad-code';
      if (user.failedLogins >= config.accountFailures) {
        user.lockedUntil = now() + config.accountLockMs;
        user.failedLogins = 0;
        reason = 'locked-now';
      }
      await saveUsers();
      if (pendingLogin.attempts >= config.codeAttempts || reason === 'locked-now') {
        tickets.delete(ticketHash);
        return finish({ ok: false, status: 401, reason, username: user.username, error: 'Too many wrong codes. Enter your username and password again.' });
      }
      return finish({ ok: false, status: 401, reason, username: user.username, error: 'That code is not right. Check the app and try again (codes change every 30 seconds).' });
    }
    tickets.delete(ticketHash);
    ipFailures.delete(ip);
    user.failedLogins = 0;
    user.lockedUntil = 0;
    // Records the used code (so it can't be replayed) or the used recovery code.
    await saveUsers();
    const result = await startSession(user, ip, userAgent);
    return finish({ ok: true, ...result, usedRecoveryCode: used === 'recovery', recoveryCodesLeft: user.totp.recovery.length });
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

  // ---------- Re-checking the password, and two-step sign-in settings ----------

  const userOf = (session) => users.find((u) => u.id === session.userId);
  const tooManyTries = { ok: false, status: 429, error: 'Too many wrong attempts. Try again in 15 minutes.' };
  const noteFailure = (ip) => ipFailures.set(ip, [...recentIpFailures(ip), now()]);

  // Sensitive changes ask for the password again. Wrong guesses count toward the per-IP limit.
  async function confirmPassword(session, password, ip = 'unknown') {
    if (recentIpFailures(ip).length >= config.ipFailures) return tooManyTries;
    await sync();
    const user = userOf(session);
    if (!user) return { ok: false, status: 401, error: 'Please sign in.' };
    if (!(await verifyPassword(String(password || ''), user.passwordHash))) {
      noteFailure(ip);
      return { ok: false, status: 400, error: 'Your password is not right.' };
    }
    return { ok: true };
  }

  function twoFactorStatus(session) {
    const user = userOf(session);
    if (!user || !user.totp) return { enabled: false };
    return { enabled: true, enabledAt: user.totp.enabledAt || null, recoveryCodesLeft: (user.totp.recovery || []).length };
  }

  // Step 1 of turning on two-step sign-in: a new secret for the authenticator app (shown as a QR code).
  async function startTwoFactor(session, { issuer }) {
    if (!key) return { ok: false, status: 503, error: 'ADMIN_ENCRYPTION_KEY is not set.' };
    await sync();
    const user = userOf(session);
    if (!user) return { ok: false, status: 401, error: 'Please sign in.' };
    if (user.totp) return { ok: false, status: 400, error: 'Two-step sign-in is already on.' };
    const secret = totp.newSecret();
    user.totpPending = { secretEnc: encrypt(key, secret, `totp-setup:${user.id}`), expires: now() + config.setupMs };
    await saveUsers();
    return { ok: true, secret, uri: totp.otpauthUri(secret, { issuer, account: user.username }) };
  }

  // Step 2: the first code from the app proves it was set up correctly. Returns the recovery codes,
  // which are shown once and stored only as hashes. Other devices are signed out.
  async function confirmTwoFactor(session, code, ip = 'unknown') {
    if (recentIpFailures(ip).length >= config.ipFailures) return tooManyTries;
    await sync();
    const user = userOf(session);
    if (!user) return { ok: false, status: 401, error: 'Please sign in.' };
    const setup = user.totpPending;
    if (!setup || setup.expires < now()) return { ok: false, status: 400, error: 'The setup timed out. Press "Turn on" to start again.' };
    let secret;
    try {
      secret = decrypt(key, setup.secretEnc, `totp-setup:${user.id}`);
    } catch {
      return { ok: false, status: 400, error: 'The setup could not be read. Press "Turn on" to start again.' };
    }
    const step = totp.verify(secret, code, { now: now() });
    if (step === null) {
      noteFailure(ip);
      return { ok: false, status: 400, error: 'That code is not right. Check that the phone\'s clock is set automatically, and type the newest code.' };
    }
    const codes = totp.recoveryCodes();
    user.totp = {
      secretEnc: encrypt(key, secret, `totp:${user.id}`), enabledAt: new Date(now()).toISOString(), lastStep: step,
      recovery: codes.map((c) => sha256(totp.normalizeRecoveryCode(c))),
    };
    delete user.totpPending;
    await saveUsers();
    const signedOut = await revokeOtherSessions(session);
    return { ok: true, recoveryCodes: codes, signedOut };
  }

  // Turning it off, or new recovery codes, needs a current code (or a recovery code).
  async function checkSecondFactor(session, code, ip) {
    if (recentIpFailures(ip).length >= config.ipFailures) return { result: tooManyTries };
    await sync();
    const user = userOf(session);
    if (!user || !user.totp) return { result: { ok: false, status: 400, error: 'Two-step sign-in is not on.' } };
    if (!useSecondFactor(user, code)) {
      noteFailure(ip);
      return { result: { ok: false, status: 400, error: 'That code is not right.' } };
    }
    return { user };
  }

  async function disableTwoFactor(session, code, ip = 'unknown') {
    const { user, result } = await checkSecondFactor(session, code, ip);
    if (!user) return result;
    delete user.totp;
    delete user.totpPending;
    await saveUsers();
    return { ok: true };
  }

  async function newRecoveryCodes(session, code, ip = 'unknown') {
    const { user, result } = await checkSecondFactor(session, code, ip);
    if (!user) return result;
    const codes = totp.recoveryCodes();
    user.totp.recovery = codes.map((c) => sha256(totp.normalizeRecoveryCode(c)));
    await saveUsers();
    return { ok: true, recoveryCodes: codes };
  }

  // ---------- Managing admins (owners only; the routes check the role) ----------

  const lastOwnerError = { ok: false, status: 400, error: 'There must always be at least one owner. Make someone else an owner first.' };

  async function setRole(userId, role) {
    if (!ROLES.includes(role)) return { ok: false, status: 400, error: 'Unknown role.' };
    await sync();
    const user = users.find((u) => u.id === userId);
    if (!user) return { ok: false, status: 404, error: 'That admin no longer exists.' };
    if (roleOf(user) === 'owner' && role !== 'owner' && owners().length <= 1) return lastOwnerError;
    user.role = role;
    await saveUsers();
    return { ok: true, user: publicUser(user) };
  }

  async function removeUser(userId) {
    await sync();
    const user = users.find((u) => u.id === userId);
    if (!user) return { ok: false, status: 404, error: 'That admin no longer exists.' };
    if (roleOf(user) === 'owner' && owners().length <= 1) return lastOwnerError;
    users = users.filter((u) => u.id !== userId);
    await saveUsers();
    await revokeSessions((s) => s.userId === userId);
    return { ok: true, user: publicUser(user) };
  }

  // A new password set by an owner (or over SSH): unlocks the account and signs it out everywhere.
  async function setPasswordFor(userId, password) {
    const problem = passwordProblem(password);
    if (problem) return { ok: false, status: 400, error: problem };
    const hash = await hashPassword(password, scryptParams);
    await sync();
    const user = users.find((u) => u.id === userId);
    if (!user) return { ok: false, status: 404, error: 'That admin no longer exists.' };
    user.passwordHash = hash;
    user.passwordChangedAt = new Date(now()).toISOString();
    user.failedLogins = 0;
    user.lockedUntil = 0;
    await saveUsers();
    const signedOut = await revokeSessions((s) => s.userId === user.id);
    return { ok: true, signedOut };
  }

  // For a lost phone without recovery codes.
  async function disableTwoFactorFor(userId) {
    await sync();
    const user = users.find((u) => u.id === userId);
    if (!user) return { ok: false, status: 404, error: 'That admin no longer exists.' };
    delete user.totp;
    delete user.totpPending;
    await saveUsers();
    return { ok: true, user: publicUser(user) };
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
    for (const [hash, pendingLogin] of tickets) if (pendingLogin.expires < now()) tickets.delete(hash);
  }

  return {
    load, sync, hasUsers, createUser, resetPassword, login, completeLogin, authenticate, checkCsrf, logout, revokeOtherSessions,
    listSessions, changePassword, sessionCookie, clearCookie, sweep, cookieName, listUsers: () => users.map(publicUser),
    confirmPassword, twoFactorStatus, startTwoFactor, confirmTwoFactor, disableTwoFactor, newRecoveryCodes,
    setRole, removeUser, setPasswordFor, disableTwoFactorFor, findUser: (name) => {
      const user = findUser(name);
      return user ? publicUser(user) : null;
    },
  };
}

module.exports = { createAuth, parseCookies, LIMITS, GENERIC_LOGIN_ERROR, ROLES };
