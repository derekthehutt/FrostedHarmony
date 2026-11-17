'use strict';

// Creates an admin user, or resets a forgotten password, from the server's command line.
// There is deliberately no sign-up page: only someone with SSH access can add admins.
//
//   docker compose exec api node scripts/create-admin.js                 create an owner
//   docker compose exec api node scripts/create-admin.js --editor        create an editor
//   docker compose exec api node scripts/create-admin.js --reset NAME    new password, unlock, sign out everywhere
//   docker compose exec api node scripts/create-admin.js --disable-2fa NAME   turn off two-step sign-in (lost phone)
//   docker compose exec api node scripts/create-admin.js --role NAME owner|editor
//   docker compose exec api node scripts/create-admin.js --list          list users
//
// Owners can do the same from the portal's Admins tab; this script is for when nobody can sign in.
// Local preview:  node scripts/create-admin.js --dev

const path = require('node:path');
const readline = require('node:readline');
const { createAuth } = require('../lib/auth');
const { ensurePrivateDir } = require('../lib/store');
const { PASSWORD_MIN } = require('../lib/crypto');

const args = process.argv.slice(2);
const DEV = args.includes('--dev');
const DATA_DIR = path.resolve(process.env.DATA_DIR || (DEV ? path.join(__dirname, '..', '..', '.local-data') : '/data'));
const ADMIN_DIR = path.join(DATA_DIR, 'admin');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Print the prompt, then swallow everything readline would echo.
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function askNewPassword() {
  for (;;) {
    const first = await ask(`New password (at least ${PASSWORD_MIN} characters, input hidden): `, { hidden: true });
    if (first.length < PASSWORD_MIN) {
      console.log(`Too short. Use at least ${PASSWORD_MIN} characters; a passphrase of 4+ random words works well.`);
      continue;
    }
    const second = await ask('Repeat the password: ', { hidden: true });
    if (first === second) return first;
    console.log('The passwords did not match. Try again.');
  }
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('Run this interactively, for example: docker compose exec api node scripts/create-admin.js');
    process.exit(1);
  }
  await ensurePrivateDir(ADMIN_DIR);
  const auth = createAuth({ dir: ADMIN_DIR });
  await auth.load();

  if (args.includes('--list')) {
    const users = auth.listUsers();
    if (!users.length) console.log('No admin users yet.');
    for (const user of users) {
      console.log(`${user.username}  ${user.role}${user.twoFactor ? ', two-step sign-in on' : ''}  (created ${user.createdAt}, password changed ${user.passwordChangedAt})`);
    }
    return;
  }

  const named = async (flag) => {
    const index = args.indexOf(flag);
    if (index === -1) return null;
    const name = args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : await ask('Username: ');
    const user = auth.findUser(name);
    if (!user) throw new Error(`No user named "${name}".`);
    return user;
  };

  const twoFactorUser = await named('--disable-2fa');
  if (twoFactorUser) {
    await auth.disableTwoFactorFor(twoFactorUser.id);
    console.log(`Two-step sign-in is off for "${twoFactorUser.username}". They can turn it on again on the Account tab.`);
    return;
  }

  const roleUser = await named('--role');
  if (roleUser) {
    const role = args[args.indexOf('--role') + 2];
    const result = await auth.setRole(roleUser.id, role);
    if (!result.ok) throw new Error(result.error);
    console.log(`"${roleUser.username}" is now ${role === 'owner' ? 'an owner' : 'an editor'}.`);
    return;
  }

  const resetIndex = args.indexOf('--reset');
  if (resetIndex !== -1) {
    const username = args[resetIndex + 1] || (await ask('Username to reset: '));
    const password = await askNewPassword();
    await auth.resetPassword(username, password);
    console.log(`Password for "${username.trim().toLowerCase()}" was reset. The account is unlocked and all its sessions were signed out.`);
    return;
  }

  const username = await ask('New admin username (letters, numbers, . - _): ');
  const password = await askNewPassword();
  const role = args.includes('--editor') ? 'editor' : 'owner';
  const user = await auth.createUser(username, password, { role });
  console.log(`${role === 'owner' ? 'Owner' : 'Editor'} "${user.username}" created. Sign in at https://<your-domain>/admin/`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
