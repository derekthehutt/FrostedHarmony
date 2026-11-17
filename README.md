# Frosted Harmony website

A cupcake showcase website for **frostedharmony.com**:

- Gallery that automatically pulls the latest Instagram posts, with `site/gallery.json` as a fallback
- Flavors and "how ordering works" sections
- Inquiry form (pricing, custom orders, events, questions) that emails you, with spam protection
- Admin portal at `/admin/` for changing email, Instagram and other settings from a browser, with
  hashed passwords, encrypted secrets and an activity log
- Runs on a home Linux server with Docker, published securely through a Cloudflare Tunnel (no router ports opened)

**Start here: [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md)**. It has step-by-step instructions from installing Linux to going live.

- [docs/RAID-SETUP.md](docs/RAID-SETUP.md): Areca ARC-1223-8i, 6 x 2 TB in RAID 6, mounted at `/srv/data`, with email alerts
- [docs/EMAIL-SETUP.md](docs/EMAIL-SETUP.md): `cupcakes@frostedharmony.com` through Cloudflare Email Routing and Gmail "Send mail as"
- [docs/ADMIN-SETUP.md](docs/ADMIN-SETUP.md): turning on the admin portal, Cloudflare Access, and recovering a lost password

## Quick reference

Preview on your PC:

```powershell
cd api
npm install
npm run dev     # open http://localhost:8080 (admin portal: http://localhost:8080/admin/)
npm test        # automated tests
```

Publish changes to the server:

```powershell
.\deploy.ps1 -Server dridge@<server-ip> -RemoteDir /srv/data/sites/frostedharmony
```

On the server (first time: `cp .env.example .env` and fill it in):

```bash
cd /srv/data/sites/frostedharmony
docker compose up -d --build
docker compose ps
docker compose logs -f
docker compose exec api node scripts/create-admin.js   # add an admin user
```

## Layout

| Path | Purpose |
|---|---|
| `site/` | Website files (HTML, CSS, JavaScript, images, `gallery.json`) |
| `site/admin/` | Admin portal pages |
| `api/` | Node.js service: Instagram feed cache, inquiry email and the admin portal API |
| `api/lib/` | Settings, sign-in/sessions, encryption, storage and audit log modules |
| `api/routes/admin.js` | `/api/admin/*` endpoints |
| `api/scripts/create-admin.js` | Creates admin users and resets passwords (SSH only) |
| `api/test/` | Automated tests (`npm test`) |
| `nginx/` | Web server configuration and shared security headers |
| `docker-compose.yml` | Runs `web` (nginx), `api` and `tunnel` (cloudflared) |
| `.env.example` | Template for server secrets. The real `.env` lives only on the server |
| `deploy.ps1` | Copies the project to the server and restarts the containers |
| `server-tools/` | `raid-check.sh` hourly RAID health email alerts, plus its config template |
