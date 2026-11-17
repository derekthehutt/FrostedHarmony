# Frosted Harmony: Complete Home Server Setup Guide

This guide takes you from "I have a spare computer and a domain from Wix" to
"**https://frostedharmony.com** is live, shows Instagram cupcake photos, and
emails us when customers send an inquiry."

It assumes **no prior Linux, Docker or web hosting experience**. Follow the parts
in order. Each part ends with a **Check** so you know it worked before moving on.

> Time needed: about 3-4 hours spread over 1-2 days (DNS changes can take a few
> hours to take effect).

**Companion guides:**

- [RAID-SETUP.md](RAID-SETUP.md): set up the Areca ARC-1223-8i RAID card. **Read Parts 1-4
  of it before installing Ubuntu (Part 2 below)**, because the hardware and RAID come first.
- [EMAIL-SETUP.md](EMAIL-SETUP.md): `cupcakes@frostedharmony.com` forwarding to Gmail,
  and sending as that address. Do it after Part 8.
- [ADMIN-SETUP.md](ADMIN-SETUP.md): the browser-based admin portal at `/admin/` for changing
  email, Instagram and other settings without SSH. Do it after Part 11.

**Recommended order with the RAID card:** RAID-SETUP Parts 1-4 -> this guide Parts 1-6
(choose the **SSD** when installing Ubuntu) -> RAID-SETUP Parts 6-8 -> this guide Parts 7-11
(deploy with `-RemoteDir /srv/data/sites/frostedharmony`) -> EMAIL-SETUP.

---

## Table of contents

- [Part 0: How it all fits together](#part-0-how-it-all-fits-together)
- [Part 1: What you need](#part-1-what-you-need)
- [Part 2: Install Ubuntu Server on the home server](#part-2-install-ubuntu-server-on-the-home-server)
- [Part 3: First login and basic setup](#part-3-first-login-and-basic-setup)
- [Part 4: Control the server from your Windows PC with SSH](#part-4-control-the-server-from-your-windows-pc-with-ssh)
- [Part 5: Basic security](#part-5-basic-security)
- [Part 6: Install Docker](#part-6-install-docker)
- [Part 7: Preview and edit the website on your PC](#part-7-preview-and-edit-the-website-on-your-pc)
- [Part 8: Point your Wix domain to Cloudflare and create the tunnel](#part-8-point-your-wix-domain-to-cloudflare-and-create-the-tunnel)
- [Part 9: Connect Instagram (optional but recommended)](#part-9-connect-instagram-optional-but-recommended)
- [Part 10: Set up email for the inquiry form](#part-10-set-up-email-for-the-inquiry-form)
- [Part 11: Copy the website to the server and start it](#part-11-copy-the-website-to-the-server-and-start-it)
- [Part 12: Updating the website later](#part-12-updating-the-website-later)
- [Part 13: Maintenance checklist](#part-13-maintenance-checklist)
- [Part 14: Troubleshooting](#part-14-troubleshooting)
- [Appendix A: Linux survival commands](#appendix-a-linux-survival-commands)
- [Appendix B: Glossary](#appendix-b-glossary)

---

## Part 0: How it all fits together

```
 Visitor's phone/computer
          |
          |  https://frostedharmony.com
          v
 +--------------------+
 |     Cloudflare     |  Free. Handles DNS, HTTPS certificate, and hides your home IP.
 +--------------------+
          ^
          |  Secure tunnel. Your server dials OUT to Cloudflare, so you do
          |  NOT open any ports on your home router.
          |
 +------------------------------ Home server (Ubuntu Linux + Docker) ---+
 |                                                                      |
 |   [tunnel] cloudflared  --->  [web] nginx  --->  [api] Node.js       |
 |                               serves the         - pulls Instagram   |
 |                               website files        photos every hour |
 |                                                  - emails inquiries  |
 +----------------------------------------------------------------------+
```

**Why this design?**

- **Cloudflare Tunnel** is the easiest, safest way to host from home:
  - No router port forwarding.
  - Works even if your home internet IP address changes, or your internet
    provider blocks normal web ports.
  - Free automatic HTTPS (the padlock in the browser).
  - Your home IP address stays private.
- **Docker** packages each piece into a "container", so you do not install web
  server software directly on Linux. One command starts or updates everything.
- **The domain stays registered with Wix.** You only tell Wix to let Cloudflare
  answer DNS questions for it, and you keep renewing the domain with Wix as usual.

**What the project folder contains** (`C:\Users\dridge\personal-website`):

| Path | What it is |
|---|---|
| `site\` | The website: `index.html` (content), `styles.css` (look), `script.js` (gallery + form), `gallery.json` and `images\` |
| `api\` | Small Node.js program for Instagram photos and the inquiry form |
| `nginx\default.conf` | Web server settings |
| `docker-compose.yml` | Tells Docker how to run the 3 containers |
| `.env.example` | Template for your private settings (passwords, tokens) |
| `deploy.ps1` | One command to copy everything from your PC to the server |

---

## Part 1: What you need

### 1.1 A computer to be the server

Almost any 64-bit PC or laptop from the last ~10 years works:

| | Minimum | Recommended |
|---|---|---|
| CPU | Any 64-bit Intel/AMD (x86-64) | Intel i3 / Ryzen 3 or better |
| Memory (RAM) | 2 GB | 4 GB or more |
| Storage | 32 GB | 120 GB+ SSD |
| Network | Wired Ethernet to your router | Wired Ethernet (avoid Wi-Fi for a server) |

> **Important:** installing Ubuntu **erases everything** on that computer's disk.
> Copy anything you want to keep off it first.

Good choices: an old desktop, an old laptop (its battery acts as a mini backup
power supply), or a small "mini PC" (about $120-200 used/new).

> Using a Raspberry Pi instead? It works, but some install steps differ. This
> guide assumes a normal Intel/AMD PC.

### 1.2 Other things

- A **USB flash drive**, 8 GB or larger. It will be erased.
- A **monitor and keyboard** for the server, only needed during installation.
- An **Ethernet cable** from the server to your home router.
- Your **Windows PC** (this one) to prepare the USB stick and manage the server.
- Login to your **Wix account** (where you bought `frostedharmony.com`).
- A free **Cloudflare account** (created in Part 8).
- Your wife's **Instagram login** (Part 9).
- A **Gmail account** to send inquiry emails (Part 10). A dedicated one such as
  `frostedharmony.orders@gmail.com` is a good idea.

### 1.3 Write down as you go

Keep a note (a password manager is ideal) with:

```
Server Linux username:      dridge
Server Linux password:      Testlab1!
Server IP address:          192.168.___.___
Cloudflare login:           __________
```

---

## Part 2: Install Ubuntu Server on the home server

**Ubuntu Server** is a free, popular version of Linux with no desktop. You
control it by typing commands. That makes it lightweight and reliable, and it's
what most web servers run.

### 2.1 Download Ubuntu Server (on your Windows PC)

1. Go to **https://ubuntu.com/download/server**.
2. Download the newest version marked **LTS** (Long Term Support), for example
   *Ubuntu Server 26.04 LTS* or *24.04 LTS*. LTS versions get security updates
   for 5+ years. The steps in this guide are the same for both.
3. You will get a large file ending in `.iso` (about 3 GB). Save it to `Downloads`.

### 2.2 Make a bootable USB stick (on your Windows PC)

1. Download **Rufus** from **https://rufus.ie** (choose the "Portable" version; no install needed).
2. Plug in the USB stick.
3. Open Rufus. Click **Yes** if Windows asks for permission.
4. **Device**: choose your USB stick. Double-check it is the right one, because it will be erased.
5. **Boot selection**: click **SELECT**, choose the Ubuntu `.iso` file.
6. Leave everything else as it is. Click **START**.
7. If asked "ISO Image mode / DD Image mode", choose **ISO Image mode (Recommended)**.
8. Confirm the warning that the drive will be erased. Wait until the bar says **READY**, then close Rufus.

### 2.3 Prepare the server computer

1. Connect the **monitor, keyboard and Ethernet cable** to the server computer.
2. Plug in the USB stick.
3. Turn it on and immediately tap the **boot menu key** repeatedly. Common keys:

   | Brand | Boot menu key |
   |---|---|
   | Dell | F12 |
   | HP | F9 (or Esc, then F9) |
   | Lenovo | F12 (or the small "Novo" button) |
   | Acer | F12 |
   | ASUS | F8 or Esc |
   | Most custom-built PCs | F11, F12 or F8 |

4. Pick your USB stick from the list. It may show as "UEFI: SanDisk..." or similar.
5. **Recommended BIOS setting.** If you can find it in the BIOS/UEFI setup
   (usually **Del** or **F2** at power-on), look under *Power* for
   **"Restore on AC Power Loss"** (or "After Power Failure") and set it to **Power On**.
   The server will then turn itself back on after a power outage.

> If it boots straight into Windows instead, restart and try a different key, or
> enter the BIOS setup and move "USB" to the top of the **Boot Order**. If you see
> a "Secure Boot" error, Ubuntu normally supports Secure Boot, but you can disable
> it in the BIOS as a fallback.

### 2.4 Walk through the installer

You'll see a purple/black screen with text. Use **arrow keys** to move, **Enter**
to select, **Space** to tick checkboxes, **Tab** to jump between fields.

1. **GRUB menu**: choose **"Try or Install Ubuntu Server"** and press Enter. Wait 1-2 minutes.
2. **Language**: **English** -> Enter.
3. **Installer update available** (may appear): choose **Continue without updating**. It's fine either way.
4. **Keyboard configuration**: **English (US)** / **English (US)** -> **Done**.
5. **Choose type of installation**: keep **Ubuntu Server** (NOT "minimized"). Leave
   "Search for third-party drivers" unticked. -> **Done**.
6. **Network configuration**: you should see your Ethernet adapter (e.g. `eno1` or
   `enp3s0`) with an address like `DHCPv4 192.168.1.57/24`.
   - **Write down that number before the slash** (e.g. `192.168.1.57`). This is the server's IP address.
   - -> **Done**.
   - If it says "disabled" or shows no address, check the cable and router.
7. **Proxy configuration**: leave **blank** -> **Done**.
8. **Ubuntu archive mirror**: wait for "This mirror location passed tests" -> **Done**.
9. **Guided storage configuration**:
   - Select **Use an entire disk** and choose the server's internal disk (NOT the USB stick).
   - **With the Areca RAID card:** choose the **SSD** on the motherboard, **not** the
     ~8 TB RAID volume. See [RAID-SETUP.md Part 5](RAID-SETUP.md#part-5-install-ubuntu-on-the-motherboard-drive).
   - Leave **Set up this disk as an LVM group** ticked.
   - Leave encryption **off** (the server must restart unattended after power loss).
   - -> **Done**.
10. **Storage configuration** summary: -> **Done** -> **Continue** to confirm the disk will be erased.
    > Tip: Ubuntu may leave part of a large disk unused at first. That's normal and
    > fine for this website.
11. **Profile configuration**. Fill in:
    - *Your name*: e.g. `Derek`
    - *Your server's name*: `frostedharmony` (lowercase, no spaces)
    - *Pick a username*: e.g. `derek` (lowercase, no spaces). **Write it down.**
    - *Choose a password* / *Confirm*: use a strong password. **Write it down.**
    - -> **Done**.
12. **Upgrade to Ubuntu Pro**: choose **Skip for now** -> **Continue**.
13. **SSH configuration**: press **Space** to tick **[X] Install OpenSSH server**.
    Leave "Allow password authentication over SSH" ticked. Leave "Import SSH key"
    as **No**. -> **Done**.
    > This is what lets you control the server from your Windows PC.
14. **Featured server snaps**: **do not tick anything**. In particular, do **not**
    tick "docker" here; we install the official version in Part 6. -> **Done**.
15. Installation runs (5-20 minutes). When **Reboot Now** appears at the bottom, select it.
16. If it says "Please remove the installation medium, then press ENTER", pull out
    the USB stick and press Enter.

### Check

After reboot you see something like:

```
frostedharmony login: _
```

Type your username, press Enter, type your password and press Enter. The password
**does not show any characters as you type**; that's normal. You should see a
welcome message ending with a prompt like:

```
derek@frostedharmony:~$
```

You're in Linux.

---

## Part 3: First login and basic setup

Type each command exactly and press **Enter** after each one. When a command starts
with `sudo` ("super user do", meaning "run as administrator"), it may ask for **your
password**. Again, nothing appears as you type.

### 3.1 Install all updates

```bash
sudo apt update
sudo apt upgrade -y
```

- `apt update` downloads the list of available updates.
- `apt upgrade -y` installs them (`-y` answers "yes" automatically).
- If a pink/purple screen asks which services to restart, press **Tab** to highlight **<Ok>** and press **Enter**.

Then restart:

```bash
sudo reboot
```

Log in again after about a minute.

### 3.2 Confirm the server's IP address

```bash
ip -4 addr show scope global
```

Look for a line like `inet 192.168.1.57/24`. The part before `/` is the IP address.

### 3.3 Give the server a permanent ("reserved") IP address

Your router hands out IP addresses automatically and may give the server a
different one later. To keep it the same, create a **DHCP reservation** in your router:

1. On your Windows PC, open a browser and go to your router's admin page. It's
   usually printed on a sticker on the router. Common addresses are
   `http://192.168.1.1`, `http://192.168.0.1` or `http://10.0.0.1`. Many routers are
   also managed through a phone app (Xfinity, Eero, Google/Nest Wifi, Orbi, etc.).
2. Log in with the router admin password (also usually on the sticker).
3. Find a section named something like **DHCP Reservation**, **Address Reservation**,
   **Static Lease**, **Reserved IP** or **Connected Devices -> (device) -> Reserve IP**.
4. Choose the device named `frostedharmony` (or match the IP from 3.2) and **reserve** its current IP.
5. Save.

> This isn't strictly required for the website (the Cloudflare tunnel works
> regardless), but it means your SSH and deploy commands always use the same address.

### 3.4 Keep the server awake (laptops and some desktops)

Ubuntu Server doesn't normally sleep, but to be safe:

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

**If it's a laptop**, also stop it from sleeping when the lid closes:

```bash
sudo nano /etc/systemd/logind.conf
```

This opens the **nano** text editor. Use the arrow keys to find these lines.
Remove the `#` at the start of each and set them to `ignore`:

```
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
```

Save with **Ctrl+O**, then **Enter**. Exit with **Ctrl+X**. Then:

```bash
sudo systemctl restart systemd-logind
```

### 3.5 Set the time zone

```bash
sudo timedatectl set-timezone America/Los_Angeles
timedatectl
```

(Use your own zone if different, e.g. `America/Denver`, `America/Chicago`,
`America/New_York`. List them with `timedatectl list-timezones`.)

### Check

- `ip -4 addr show scope global` shows the same IP you reserved.
- `timedatectl` shows the correct local time.

From here on, you can **unplug the monitor and keyboard**. Everything else is done from your Windows PC.

---

## Part 4: Control the server from your Windows PC with SSH

**SSH** gives you the server's command line in a window on your PC.
Windows 10/11 already includes it.

### 4.1 Connect for the first time

1. On your Windows PC, open **Windows Terminal** or **PowerShell** (Start menu -> type "PowerShell").
2. Type (use your username and IP):

   ```powershell
   ssh derek@192.168.1.57
   ```

3. The first time, it asks:
   `Are you sure you want to continue connecting (yes/no/[fingerprint])?`
   Type **yes** and press Enter.
4. Enter your Linux password.
5. You now see `derek@frostedharmony:~$`. Every command you type here runs **on the server**.
6. To disconnect, type `exit`.

> **Copy and paste in the terminal:** select text to copy it. To paste, **right-click**
> (or press **Ctrl+Shift+V** in Windows Terminal). Plain Ctrl+V may not work.

### 4.2 Set up key login (no more typing the password)

A **key pair** is like a digital key and lock. It's more secure than a password and
lets the `deploy.ps1` script run without prompting.

**On your Windows PC** (in PowerShell, NOT connected to the server):

```powershell
ssh-keygen -t ed25519 -C "frostedharmony server"
```

- "Enter file in which to save the key": just press **Enter**.
- "Enter passphrase": press **Enter** twice for none, or type a passphrase you'll remember.
  (No passphrase is simplest; your PC login still protects it.)

Now copy the public key ("the lock") to the server. Change `derek@192.168.1.57` to yours:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | ssh derek@192.168.1.57 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Type your Linux password one last time.

### 4.3 Save a shortcut (optional, convenient)

So you can type `ssh frostedharmony` instead of the full address:

```powershell
notepad $env:USERPROFILE\.ssh\config
```

If Notepad asks to create the file, click **Yes**. Paste (with your values), save and close:

```
Host frostedharmony
    HostName 192.168.1.57
    User derek
```

> Save it **without** a `.txt` extension. In Notepad's Save dialog, set "Save as
> type" to **All files** if needed.

### Check

```powershell
ssh frostedharmony
```

(or `ssh derek@192.168.1.57`) logs you in **without asking for a password**. Type `exit` to leave.

---

## Part 5: Basic security

Run these **on the server** (connect with `ssh frostedharmony` first).

### 5.1 Turn on the firewall

```bash
sudo ufw allow OpenSSH
sudo ufw enable
```

Answer **y** to "Command may disrupt existing ssh connections". It won't disrupt
yours, because we just allowed SSH.

```bash
sudo ufw status
```

should show `Status: active` and `OpenSSH  ALLOW  Anywhere`.

> We do **not** open ports 80/443. The Cloudflare tunnel only makes outgoing
> connections, so nothing from the internet can reach the server directly.

### 5.2 Confirm automatic security updates are on

Ubuntu installs security fixes automatically by default. Confirm:

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
```

Choose **<Yes>** and press Enter.

### 5.3 (Optional, recommended) Disable password logins over SSH

Only do this **after** Part 4.2 works (key login without a password), or you could lock yourself out.

```bash
echo "PasswordAuthentication no" | sudo tee /etc/ssh/sshd_config.d/01-no-passwords.conf
sudo systemctl restart ssh
```

**Before closing your current window**, open a *second* PowerShell window and check
that `ssh frostedharmony` still logs in. If it doesn't, undo it from the first window:

```bash
sudo rm /etc/ssh/sshd_config.d/01-no-passwords.conf
sudo systemctl restart ssh
```

> You can always log in at the server with a monitor and keyboard, where passwords still work.

---

## Part 6: Install Docker

**Docker** runs programs in isolated "containers". We use the official Docker
packages, as described at https://docs.docker.com/engine/install/ubuntu/.

On the server, copy and paste these **one block at a time**.

### 6.1 Add Docker's official software source

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

### 6.2 Install Docker and Docker Compose

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### 6.3 Let your user run Docker without `sudo`

```bash
sudo usermod -aG docker $USER
exit
```

Then reconnect (`ssh frostedharmony`) so the change takes effect.

### 6.4 Make sure Docker starts automatically after a reboot

```bash
sudo systemctl enable docker containerd
```

### Check

```bash
docker run --rm hello-world
docker compose version
```

You should see **"Hello from Docker!"** and a version like `Docker Compose version v2.x.x`.

> If you get `permission denied ... docker.sock`, you didn't reconnect after 6.3.
> Type `exit` and `ssh frostedharmony` again.

---

## Part 7: Preview and edit the website on your PC

You edit the website on **your Windows PC**, check it in a browser, then copy it to
the server (Part 11). The server never needs to be edited directly.

### 7.1 One-time: install Node.js on your PC

Node.js is already installed on this PC. On another PC, install the **LTS** version from https://nodejs.org.

### 7.2 Start the preview

In PowerShell on your PC:

```powershell
cd C:\Users\dridge\personal-website\api
npm install
npm run dev
```

Open **http://localhost:8080** in your browser. To stop the preview, press **Ctrl+C** in PowerShell.

In preview mode:

- The gallery shows the photos listed in `site\gallery.json` (Instagram is connected later on the server).
- Inquiry form messages are **not emailed**. They're saved to
  `C:\Users\dridge\personal-website\.local-data\inquiries.jsonl` so you can see them working.

### 7.3 Things to personalize

**Once the site is live, use the admin portal** (**Page content** tab, see
[ADMIN-SETUP.md](ADMIN-SETUP.md)) to change the Instagram link, headline, flavors and prices, the
ordering steps, contact text, and the browser-tab title. It has preview and undo, and no files or
deploys are involved. After the first **Publish** there, the website is built from the portal's
content, and text edits to `site\index.html` no longer appear.

Before the site is live (or for changes the portal can't make yet), edit the files directly in VS
Code or Notepad. After saving, refresh the browser to see changes.

| What | Where |
|---|---|
| Instagram account link | `site\index.html`, the `<body data-instagram-url="...">` line near the top |
| Headline and intro text | `site\index.html`, the `hero` section |
| Flavors | `site\index.html`, the `flavors` section. Copy/paste an `<article class="card">...</article>` block to add one |
| How ordering works, lead times, pickup/delivery | `site\index.html`, the `ordering` and `contact` sections |
| Colors and fonts | Admin portal, **Page content → Design**. (Without the portal: `site\styles.css`, the `:root { ... }` block at the top) |
| Page title in Google/browser tab | `site\index.html`, the `<title>` and `<meta name="description">` lines |

### 7.4 Adding your own photos (works with or without Instagram)

**Once the site is live, use the admin portal's Photos tab** (see [ADMIN-SETUP.md](ADMIN-SETUP.md)).
Upload straight from a phone or computer. Photos are resized automatically and their location data
is removed. Then choose them for the gallery, top banner or flavors on the **Page content** tab.

The manual method below still works as a last fallback when no portal photos are chosen and
Instagram isn't connected (or is temporarily down). In that case the site shows the photos listed
in `site\gallery.json`.

1. Copy photos into `site\images\gallery\`, e.g. `rainbow-birthday.jpg`.
   - Keep files small: about **1200 pixels wide**, under **500 KB**. Free tool: https://squoosh.app
   - Use lowercase file names with dashes, no spaces.
2. Edit `site\gallery.json` to list them:

   ```json
   [
     { "image": "/images/gallery/rainbow-birthday.jpg", "caption": "Rainbow birthday cupcakes" },
     { "image": "/images/gallery/wedding-white.jpg", "caption": "White wedding cupcakes with pearls" }
   ]
   ```

   Commas go **between** items, but not after the last one.

---

## Part 8: Point your Wix domain to Cloudflare and create the tunnel

### 8.1 Create a Cloudflare account and add your domain

1. Go to **https://dash.cloudflare.com/sign-up** and create a free account. Verify your email.
2. In the dashboard, click **Add a domain** (or "Add site" / "Onboard a domain").
3. Enter `frostedharmony.com`. Keep "Quick scan for DNS records" selected. Click **Continue**.
4. Choose the **Free** plan -> **Continue**.
5. Cloudflare shows the DNS records it found (copied from Wix).
   - **If you have email at this domain** (e.g. `hello@frostedharmony.com`), make sure
     the **MX** and **TXT** records are in the list. If unsure, leave everything as found.
   - Records that point the website to Wix (an **A** record for `frostedharmony.com` and a
     **CNAME** for `www`) will be replaced later in 8.4. You can delete them now or later.
6. Click **Continue**. Cloudflare shows **two nameservers**, for example:

   ```
   ada.ns.cloudflare.com
   bob.ns.cloudflare.com
   ```

   Keep this page open; you need them next.

### 8.2 Change the nameservers at Wix

Nameservers decide who answers "where is frostedharmony.com?" for the whole internet.
Here you hand that job from Wix to Cloudflare. The domain itself stays registered with Wix.

1. Log in at **https://www.wix.com** and open **Domains** (from your account menu,
   or go to https://manage.wix.com/account/domains).
2. Next to `frostedharmony.com`, click the **Domain Actions** (three dots) menu.
3. Look for **Change name servers** (it may be under **Advanced** or **Manage DNS Records**,
   then a **Name servers** section with **Edit / Change**). Wix moves menus occasionally.
   If you can't find it, search Wix Help for **"Changing the name servers of a domain purchased from Wix"**.
4. Replace the Wix nameservers with the **two Cloudflare nameservers** from 8.1. Save and confirm.
5. Back in Cloudflare, click **Done, check nameservers**.

> **What happens next:** it takes from 10 minutes to 24 hours (usually under 1-2 hours).
> Cloudflare emails you when the domain is **Active**. During this time, any Wix
> site on the domain will stop showing.
>
> If you pay Wix for a premium plan only to connect this domain, you can cancel the
> plan later. **Keep paying the yearly domain renewal** (or transfer the domain to
> another registrar later).

### 8.3 Recommended Cloudflare settings

Once the domain is **Active** (it shows a green "Active" label in Cloudflare):

1. Select `frostedharmony.com` -> **SSL/TLS** -> **Overview**: choose **Full**.
2. **SSL/TLS** -> **Edge Certificates**: turn **Always Use HTTPS** **On**.

### 8.4 Create the tunnel

1. In the Cloudflare dashboard, open **Zero Trust** from the left menu (it may open
   in a new tab). In newer dashboards, tunnels may also be under **Networking -> Tunnels**.
   - The first time, it asks you to pick a "team name" (anything, e.g. `frostedharmony`)
     and the **Free** plan. It may ask for a payment card even for the free plan; you
     won't be charged on the Free plan.
2. Go to **Networks -> Tunnels** -> **Create a tunnel**.
3. Choose **Cloudflared** -> **Next**.
4. Name it `frostedharmony-home` -> **Save tunnel**.
5. On "Install and run a connector", click the **Docker** option. You'll see a command like:

   ```
   docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJhIjoiNmY...very long...
   ```

   **Copy only the long part after `--token `** (it starts with `eyJ`). This is your
   **tunnel token**. Treat it like a password. Paste it somewhere safe for Part 11.
   **Do not run that command**; our `docker-compose.yml` already does this.
6. Click **Next** to reach **Route traffic / Public hostnames** and add:

   | Subdomain | Domain | Path | Service Type | URL |
   |---|---|---|---|---|
   | *(leave empty)* | `frostedharmony.com` | *(empty)* | **HTTP** | `web:80` |

   Click **Save** / **Complete setup**.
7. Add a second public hostname for `www`: open the tunnel -> **Public Hostname** tab ->
   **Add a public hostname**:

   | Subdomain | Domain | Service Type | URL |
   |---|---|---|---|
   | `www` | `frostedharmony.com` | **HTTP** | `web:80` |

> **Error "A record with that host already exists"?** Go to your domain -> **DNS** ->
> **Records**, delete the old **A** / **CNAME** records for `frostedharmony.com` (shown
> as `@` or the domain name) and/or `www`, then add the hostname again. Don't delete
> **MX** or **TXT** records (email).

> `web:80` means "the container named **web**, port 80" inside Docker. The tunnel
> container reaches it over Docker's private network.

### Check

- Cloudflare shows the domain as **Active**.
- The tunnel exists. It shows **Inactive/Down** until Part 11; that's expected.
- In **DNS -> Records**, you see `frostedharmony.com` and `www` as **CNAME** records pointing
  to `....cfargotunnel.com`.

---

## Part 9: Connect Instagram (optional but recommended)

The server fetches the latest posts from her Instagram every hour, saves the images,
and shows them in the gallery. Clicking a photo opens the post on Instagram.

> Meta (Instagram's owner) changes these screens often. If a button name differs,
> look for the closest match. The goal of this part is one thing: a **long-lived
> Instagram access token** with the `instagram_business_basic` permission.

### 9.1 Make the Instagram account "Professional" (free, 2 minutes)

In the **Instagram app** on her phone:

1. Profile -> menu (three lines) -> **Settings and activity**.
2. **Account type and tools** -> **Switch to professional account**.
3. Pick a category (e.g. "Bakery") and choose **Business** or **Creator**. Either works.

This doesn't change anything visitors see, and it adds free insights.

### 9.2 Create a Meta developer app

1. Go to **https://developers.facebook.com** and click **Get Started** / **Log in**
   (uses a Facebook account; yours or hers). Follow the prompts to register as a
   developer (it may ask to verify a phone number).
2. Click **My Apps** -> **Create App**.
3. **App name**: `Frosted Harmony Website`. **Contact email**: your email. -> **Next**.
4. **Use case**: choose **"Manage messaging & content on Instagram"** -> **Next**.
5. If asked about a **Business portfolio**, choose **"I don't want to connect a business portfolio yet"**.
6. Continue through to **Create app**, re-entering your Facebook password if asked.

### 9.3 Generate the access token

1. In the app dashboard, open **Use cases** -> the Instagram use case -> **Customize**
   (or **Instagram -> API setup with Instagram login**).
2. Find **"Generate access tokens"** and click **Add account**.
3. Log in with **her Instagram account** and approve the permissions.
   - If the account isn't allowed: go to **App roles -> Roles -> Add People ->
     Instagram Tester** and enter her Instagram username. Then in the Instagram app:
     **Settings -> Website permissions -> Apps and websites -> Tester invites -> Accept**.
     Try **Add account** again.
4. Next to her account, click **Generate token**, tick the agreement, and **copy the token**.
   It's very long and usually starts with `IG`. Keep it private.

> **You do not need to "publish" the app or submit it for App Review.** It can stay in
> **Development** mode because it only reads her own account. The server automatically
> refreshes the token weekly so it never reaches its 60-day expiry, as long as the server
> runs at least once every few weeks.

> **If Meta only offers "API setup with Facebook login" (unified login)**, which needs a
> business portfolio: that works too. Use a business **system-user token** (it starts with
> `EAA`) instead. The steps are in `docs/ADMIN-SETUP.md`, section "Instagram". Paste either kind
> of token into the admin portal's Settings and press **Check Instagram connection**.

### Check (later, on the server)

The easiest check is the admin portal: **Settings → Check Instagram connection** shows the account
it connected to. Or test an Instagram-login token on the server (replace `PASTE_TOKEN`):

```bash
curl "https://graph.instagram.com/me?fields=username&access_token=PASTE_TOKEN"
```

It should print `{"username":"...","id":"..."}`.

---

## Part 10: Set up email for the inquiry form

When a customer submits the form, the server sends an email to your inbox. The email's
**Reply-To** is the customer's address, so you can simply click **Reply**.

The easiest way is a Gmail account with an **App password** (a special 16-letter password
used only by the website).

1. Sign in to the Gmail account you want to send from (e.g. `frostedharmony.orders@gmail.com`).
2. Go to **https://myaccount.google.com/security**.
3. Turn on **2-Step Verification** if it's off. App passwords require it.
4. Go to **https://myaccount.google.com/apppasswords**, or search "App passwords" in the
   search bar at the top of your Google Account page.
5. App name: `Frosted Harmony website` -> **Create**.
6. Google shows a 16-letter password like `abcd efgh ijkl mnop`. **Copy it now**, because
   it's only shown once.

Values for Part 11:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=frostedharmony.orders@gmail.com
SMTP_PASS=abcdefghijklmnop          (the app password; spaces are fine either way)
MAIL_TO=cupcakes@frostedharmony.com  (where inquiries arrive; see EMAIL-SETUP.md. Her Gmail works until then)
MAIL_FROM=frostedharmony.orders@gmail.com  (must be the same Gmail address)
```

> Every inquiry is also saved on the server as a backup (see Part 13), so nothing is
> lost if email has a hiccup.

---

## Part 11: Copy the website to the server and start it

### 11.1 Copy the files (from your Windows PC)

In PowerShell on your PC:

```powershell
cd C:\Users\dridge\personal-website
.\deploy.ps1 -Server derek@192.168.1.57
```

(or `.\deploy.ps1 -Server frostedharmony` if you created the shortcut in 4.3)

> **"running scripts is disabled on this system"?** Run this once, then try again:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (answer **Y**).

The first time, it copies the files to `/home/derek/frostedharmony` on the server and
says **"No .env file yet"**. That's expected.

### 11.2 Create the private settings file (on the server)

```powershell
ssh frostedharmony
```

Then on the server:

```bash
cd ~/frostedharmony
cp .env.example .env
chmod 600 .env
nano .env
```

`chmod 600` makes the file readable only by you. In **nano**, use the arrow keys to move
and fill in the values after the `=` signs (no spaces around `=`, no quotes needed):

```
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...the long tunnel token from Part 8.4...
INSTAGRAM_ACCESS_TOKEN=IGAA...the token from Part 9 (or leave empty for now)...
SMTP_USER=frostedharmony.orders@gmail.com
SMTP_PASS=abcdefghijklmnop
MAIL_TO=your-wifes-email@example.com
MAIL_FROM=frostedharmony.orders@gmail.com
```

To paste into nano, **right-click** in the terminal window.
Save: **Ctrl+O**, **Enter**. Exit: **Ctrl+X**.

### 11.3 Start everything

```bash
docker compose up -d --build
```

- `up` starts the containers, `-d` runs them in the background, and `--build` builds the API container.
- The first run downloads images and takes 1-3 minutes.

### 11.4 Check it's running

```bash
docker compose ps
```

All three (`web`, `api`, `tunnel`) should show **Up** (or **running**). `api` shows **(healthy)** after about a minute.

```bash
curl -s http://127.0.0.1:8080/api/health
```

Expected: `{"ok":true,"instagramPosts":12,"email":true}`.
(`instagramPosts` is 0 if you haven't added a token yet.)

```bash
docker compose logs tunnel --tail 20
```

Look for lines containing **`Registered tunnel connection`**. In Cloudflare, the tunnel now shows **Healthy**.

### Check: the big moment

On your phone (turn **Wi-Fi off** to test from outside your home), open:

**https://frostedharmony.com**

You should see the site with a padlock. Then:

1. Scroll to the gallery: Instagram photos (or your `gallery.json` photos).
2. Send a test inquiry with the form. The email should arrive within a minute.
   (Check spam the first time and mark it "Not spam".)
3. Try **https://www.frostedharmony.com** too.

The site is live.

---

## Part 12: Updating the website later

### Changing text, photos or styles (the usual case)

1. Edit the files under `C:\Users\dridge\personal-website\site\` on your PC.
2. Preview with `npm run dev` (Part 7.2) if you like.
3. Publish:

   ```powershell
   cd C:\Users\dridge\personal-website
   .\deploy.ps1 -Server frostedharmony
   ```

4. Refresh the site. If you don't see changes, press **Ctrl+F5**. Cloudflare may cache
   files for a short time; you can also use Cloudflare -> **Caching -> Configuration ->
   Purge Everything**.

The deploy script never overwrites your `.env` on the server.

### Changing settings in `.env`

```bash
ssh frostedharmony
cd ~/frostedharmony
nano .env
docker compose up -d
```

`docker compose up -d` recreates any container whose settings changed.

### Tip: keep a backup of the website files

Copy `C:\Users\dridge\personal-website` to OneDrive/Google Drive occasionally, or put it
in a private GitHub repository. The `.gitignore` file already keeps secrets out.

---

## Part 13: Maintenance checklist

**Automatic (nothing to do):**

- Security updates for Ubuntu install themselves.
- The containers restart automatically after a crash or reboot (`restart: unless-stopped`).
- Instagram photos refresh hourly, and the Instagram token refreshes weekly.
- After a power outage, the server turns back on (if you set the BIOS option in 2.3)
  and the site comes back by itself.

**Monthly (5 minutes):**

```bash
ssh frostedharmony
sudo apt update && sudo apt upgrade -y
cd ~/frostedharmony
docker compose pull
docker compose up -d --build
docker image prune -f
```

If `ls /var/run/reboot-required` doesn't say "No such file", reboot: `sudo reboot`.
The site is down for about one minute.

**Useful commands (on the server, inside `~/frostedharmony`):**

| Task | Command |
|---|---|
| See status | `docker compose ps` |
| Live logs for everything (Ctrl+C to stop) | `docker compose logs -f` |
| Logs for one part | `docker compose logs api --tail 50` |
| Restart everything | `docker compose restart` |
| Stop the website | `docker compose down` |
| Start it again | `docker compose up -d` |
| See saved inquiries (backup) | `docker compose exec api cat /data/inquiries.jsonl` |
| Disk space | `df -h /` |

**Yearly:** renew `frostedharmony.com` at Wix (turn on auto-renew).

---

## Part 14: Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `ssh: connect to host ... timed out` | Server is off, or its IP changed. Check the router's device list; set the DHCP reservation (3.3). |
| `Permission denied (publickey)` | Key login not set up, and passwords are disabled. Log in at the server with a keyboard and repeat 4.2. |
| `permission denied ... docker.sock` | Reconnect after adding yourself to the docker group (6.3). |
| `docker compose up` says `Set CLOUDFLARE_TUNNEL_TOKEN in the .env file` | `.env` is missing or the token is empty. Repeat 11.2. Make sure you're in `~/frostedharmony`. |
| Browser shows **Cloudflare Error 1033** | The tunnel isn't connected. Run `docker compose logs tunnel`. Usually a wrong or partial token in `.env`; fix it and run `docker compose up -d`. |
| Browser shows **Error 502 / Bad gateway** | The tunnel works but can't reach the website. In Cloudflare, check the public hostname URL is exactly `web:80` with type **HTTP**. Check `docker compose ps` shows `web` running. |
| `DNS_PROBE_FINISHED_NXDOMAIN` / site not found | Nameserver change not finished yet (wait, up to 24h), or the public hostname/CNAME is missing (8.4). |
| Site works but no Instagram photos | The admin portal's Dashboard shows the reason in plain words (or run `docker compose logs api`). An expired or revoked token needs replacing (Part 9): paste the new one into the portal's Settings. Until then `gallery.json` photos are shown. |
| Form says "contact form is not set up yet" | SMTP values in `.env` are empty. Fill in Part 10 values and run `docker compose up -d`. |
| Form says "could not send your message" | `docker compose logs api` shows the email error. "Invalid login" means the app password is wrong, or 2-Step Verification is off. |
| Changes don't appear after deploy | Hard refresh (Ctrl+F5); purge the Cloudflare cache (Part 12). |
| Server disk full | `docker image prune -af` and `sudo apt autoremove -y`. |

**Get help effectively:** run `docker compose ps` and `docker compose logs --tail 50`,
and include the output (remove any tokens or passwords) when asking for help.

---

## Appendix A: Linux survival commands

| Command | Meaning |
|---|---|
| `pwd` | Show which folder you're in |
| `ls -la` | List files (including hidden ones like `.env`) |
| `cd ~/frostedharmony` | Go to the website folder (`~` = your home folder) |
| `cd ..` | Go up one folder |
| `nano file` | Edit a file (Ctrl+O save, Enter, Ctrl+X exit) |
| `cat file` | Print a file |
| `sudo command` | Run as administrator (asks for your password) |
| `sudo reboot` | Restart the server |
| `sudo shutdown now` | Turn the server off safely (never just pull the plug) |
| `exit` | Close the SSH session |
| Up arrow | Recall previous commands |
| Tab | Auto-complete file and folder names |
| Ctrl+C | Stop the running command |

---

## Appendix B: Glossary

- **Domain**: the name people type (`frostedharmony.com`). Rented yearly from a *registrar* (Wix).
- **DNS**: the internet's phone book. It turns names into server addresses.
- **Nameservers**: the company that answers DNS questions for your domain (Cloudflare, after Part 8).
- **IP address**: a device's number on a network, e.g. `192.168.1.57` at home.
- **SSH**: a secure way to type commands on another computer.
- **Docker / container**: a packaged, isolated program with everything it needs to run.
- **Image**: the template a container is created from (e.g. `nginx:1.27-alpine`).
- **Docker Compose**: runs several containers together from `docker-compose.yml`.
- **nginx**: the web server that sends the website files to browsers.
- **Cloudflare Tunnel (cloudflared)**: a secure outgoing connection that brings visitors to your server without opening router ports.
- **HTTPS / SSL / TLS**: encryption between visitors and the site (the padlock).
- **API**: a small program the web page talks to (here: Instagram photos and the inquiry form).
- **Token**: a long secret string that proves permission, like a password for programs.
- **SMTP**: the standard for sending email.
