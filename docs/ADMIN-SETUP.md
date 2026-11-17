# Admin Portal Setup

The admin portal at **https://frostedharmony.com/admin/** lets you change site settings from a
browser without SSH. This guide covers turning it on, protecting it, and recovering access.

**What it can change today (phase 1):**

- Where inquiry emails go, the sender address and the SMTP (Gmail) settings, with a **Send test email** button
- The Instagram access token and how many posts to show, with a **Check Instagram connection** button
- The site name used in emails
- Your own password, and which devices are signed in

The **Dashboard** shows whether email and Instagram are working, the latest inquiries
(including ones flagged as spam) and recent admin activity.

Page text, photos and colors come in later phases.

---

## How it is protected

| Layer | What it does |
|---|---|
| **Cloudflare Access** (Part 5) | Before anyone even sees the sign-in page, Cloudflare emails them a one-time code and lets in only the addresses you list. |
| **Admin sign-in** | Username and password. Passwords are stored only as **scrypt hashes**, so they can't be read back, not even by you. |
| **Brute-force limits** | 5 failed sign-ins from one IP address in 15 minutes blocks that address for 15 minutes. 10 failures lock the account for 15 minutes. |
| **Sessions** | Secure, `HttpOnly`, `SameSite=Strict` cookie. Signs out after 30 minutes idle or 12 hours in total. Changing your password signs out every other device. |
| **CSRF protection** | Every change must carry a per-session token and come from the site itself. |
| **Encrypted secrets** | The SMTP password and Instagram token are stored with **AES-256-GCM** encryption, and the portal never shows them again. |
| **Audit log** | Sign-ins, failed sign-ins and setting changes are recorded with time, user and IP address. Secrets are never logged. |

**What stays SSH-only, on purpose:** the Cloudflare tunnel token, `ADMIN_ENCRYPTION_KEY`,
creating admin users, and Docker/server configuration. If these could be changed from a
browser, a stolen admin password could take over or lock you out of the server.

---

## Part 1: Back up the site data (on the server)

The portal adds files to the same Docker volume that holds the Instagram photos and saved
inquiries. Take a backup first:

```bash
cd /srv/data/sites/frostedharmony
VOL=$(docker volume ls -q | grep 'instagram-data$')
docker run --rm -v "$VOL":/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/site-data-$(date +%F).tgz -C /data .
ls -lh site-data-*.tgz
```

---

## Part 2: Create the encryption key (on the server)

```bash
cd /srv/data/sites/frostedharmony
openssl rand -hex 32
```

It prints 64 characters. Then:

```bash
nano .env
```

Add this line, pasting the 64 characters after the `=`:

```
ADMIN_ENCRYPTION_KEY=...the 64 characters...
```

Save (**Ctrl+O**, **Enter**) and exit (**Ctrl+X**).

> **Save a copy of the key in your password manager.** If it's lost or changed, nothing
> breaks badly: admin passwords still work, but the SMTP password and Instagram token
> saved in the portal must be typed in again. Never put the key in the portal, in chat, or
> in GitHub.

---

## Part 3: Deploy (on your Windows PC)

```powershell
cd C:\Users\dridge\personal-website
.\deploy.ps1 -Server dridge@<server-ip> -RemoteDir /srv/data/sites/frostedharmony
```

Use the same `-Server` value you normally deploy with (your Linux username and the server's IP
address, or the SSH shortcut from SETUP-GUIDE Part 4.3).

The script rebuilds the containers. On the server, check:

```bash
cd /srv/data/sites/frostedharmony
docker compose logs api --tail 20
```

Look for `Admin portal has no admin users yet` (expected for now). If it says
`Admin portal is disabled: ADMIN_ENCRYPTION_KEY is not set`, recheck Part 2.

---

## Part 4: Create the admin accounts (on the server)

```bash
cd /srv/data/sites/frostedharmony
docker compose exec api node scripts/create-admin.js
```

Enter a username (for example `derek`) and a password of **at least 12 characters**. A
passphrase of four or more random words is easy to type and hard to guess. The password isn't
shown while you type.

Run it again for each person who needs access (for example your wife). Each person should
have their own account, so the activity log shows who changed what.

---

## Part 5: Put Cloudflare Access in front of the portal (strongly recommended)

This takes about 10 minutes and blocks nearly all automated attacks, because strangers never
reach the sign-in page. It's free for up to 50 users.

1. Open **https://one.dash.cloudflare.com** (Cloudflare Zero Trust). The first time, pick a
   team name and the **Free** plan. A payment card may be requested but isn't charged.
2. Go to **Access -> Applications -> Add an application -> Self-hosted**.
3. **Application name:** `Frosted Harmony admin`. **Session duration:** `24 hours`.
4. **Public hostname / destinations**, add two:

   | Subdomain | Domain | Path |
   |---|---|---|
   | *(empty)* | `frostedharmony.com` | `admin` |
   | *(empty)* | `frostedharmony.com` | `api/admin` |

5. **Policy:** name `Owners`, action **Allow**, include **Emails** -> your email address and
   your wife's.
6. **Login methods:** **One-time PIN** is enough. Save the application.

Test it in a private browser window: **https://frostedharmony.com/admin/** should first ask
for your email and a code, then show the portal's sign-in page.
**https://frostedharmony.com/** must still open normally without any code.

> Cloudflare renames these screens from time to time. The goal is one self-hosted Access
> application covering `frostedharmony.com/admin` and `frostedharmony.com/api/admin` that
> allows only your two email addresses.

### Make sure Cloudflare never caches the portal

nginx already sends `Cache-Control: no-store` for the portal. As a second safeguard:
**frostedharmony.com -> Caching -> Cache Rules -> Create rule**:

- **If:** URI Path *starts with* `/admin` **OR** URI Path *starts with* `/api/`
- **Then:** Cache eligibility **Bypass cache**. Under Browser TTL, choose **Respect origin**.

---

## Part 6: First sign-in

1. Open **https://frostedharmony.com/admin/** and sign in.
2. **Settings:** the badges show where each value comes from:
   - **From .env file**: set on the server in `.env`.
   - **Set here**: saved in the portal. This overrides `.env`. **Undo** removes it and falls
     back to `.env`.
   - **Default**: neither is set.
3. Press **Send test email** and check that the message arrives (look in Spam the first time).
4. When everything works, you can delete `SMTP_PASS` and `INSTAGRAM_ACCESS_TOKEN` from `.env`
   and keep them only in the portal, where they're encrypted. This is optional: if you keep
   them in `.env`, the values saved in the portal still win.

---

## If something goes wrong

| Problem | Fix |
|---|---|
| Forgot your password | On the server: `docker compose exec api node scripts/create-admin.js --reset derek`. This sets a new password, unlocks the account and signs out all of that user's devices. |
| "Sign-in failed" even with the right password | After 10 failures the account locks for 15 minutes. Wait, or reset it as above. |
| "Too many failed sign-in attempts" | That IP address is blocked for 15 minutes. Wait, or try from another network. |
| Can't remember the usernames | `docker compose exec api node scripts/create-admin.js --list` |
| Portal says "not set up yet" | `ADMIN_ENCRYPTION_KEY` is missing from `.env` (Part 2), or no admin exists yet (Part 4). Then run `docker compose up -d`. |
| "could not be decrypted" warning | `ADMIN_ENCRYPTION_KEY` changed. Put the old key back, or type the SMTP password and Instagram token into the portal again. |
| Changes say "session token is missing or out of date" | The session expired or you signed out in another tab. Reload the page and sign in again. |
| Cloudflare asks for a code every time | Normal after the Access session ends (24 hours as set in Part 5). |
| Need to restore the backup | Set `VOL` as in Part 1, run `docker compose down`, then `docker run --rm -v "$VOL":/data -v "$PWD":/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/site-data-DATE.tgz -C /data'`, then `docker compose up -d`. |

---

## Where the portal keeps its files (on the server)

Inside the API container at `/data/admin/` (the `instagram-data` Docker volume). Only the API
container's user can read them:

| File | Contents |
|---|---|
| `users.json` | Admin usernames and password **hashes** |
| `sessions.json` | Active sign-ins, stored as hashes, so the file can't be used to sign in |
| `settings.json` | Settings saved in the portal. Secrets are encrypted |
| `audit.log` | Activity log, one JSON line per action |

To read the activity log on the server: `docker compose exec api tail -n 20 /data/admin/audit.log`

---

## Trying the portal on your PC

The local preview creates its own throwaway encryption key, so no `.env` is needed:

```powershell
cd C:\Users\dridge\personal-website\api
npm install
node scripts/create-admin.js --dev      # create a local test admin
npm run dev                             # then open http://localhost:8080/admin/
npm test                                # automated tests
```
