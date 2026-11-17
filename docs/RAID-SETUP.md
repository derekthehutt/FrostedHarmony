# Areca ARC-1223-8i RAID Setup Guide

This guide sets up your **Areca ARC-1223-8i** card with **6 x 2 TB WD drives** as one
protected storage area for the server. Ubuntu itself runs from a **separate drive on the
motherboard**; the RAID holds the website(s), Docker data, and anything else you store.

> **Do these parts in order.** Part 1 protects the data that's on your drives now.
> Building the RAID **erases all six drives**.

---

## Table of contents

- [Part 0: What RAID is (and isn't)](#part-0-what-raid-is-and-isnt)
- [Part 1: Back up the data on the drives first](#part-1-back-up-the-data-on-the-drives-first)
- [Part 2: Check your drives are suitable](#part-2-check-your-drives-are-suitable)
- [Part 3: Install the card and drives](#part-3-install-the-card-and-drives)
- [Part 4: Create the RAID in the Areca setup screen](#part-4-create-the-raid-in-the-areca-setup-screen)
- [Part 5: Install Ubuntu on the motherboard drive](#part-5-install-ubuntu-on-the-motherboard-drive)
- [Part 6: Format and mount the RAID in Ubuntu](#part-6-format-and-mount-the-raid-in-ubuntu)
- [Part 7: Store Docker and the website on the RAID](#part-7-store-docker-and-the-website-on-the-raid)
- [Part 8: Install the Areca tool and email alerts](#part-8-install-the-areca-tool-and-email-alerts)
- [Part 9: Routine health checks](#part-9-routine-health-checks)
- [Part 10: When a drive fails](#part-10-when-a-drive-fails)
- [Part 11: Backups (RAID is not a backup)](#part-11-backups-raid-is-not-a-backup)
- [Troubleshooting](#troubleshooting)

---

## Part 0: What RAID is (and isn't)

**RAID** combines several drives into one big "virtual drive". Depending on the
**RAID level**, it can keep working when a drive dies.

Options for your **6 x 2 TB** drives:

| Level | Usable space | Drives that can fail | Speed | Verdict |
|---|---|---|---|---|
| RAID 0 | 12 TB | **0** (any failure loses everything) | Fastest | Never for important data |
| RAID 5 | 10 TB | 1 | Good | Risky: a second failure during the long rebuild loses everything |
| **RAID 6** | **8 TB** | **Any 2** | Good for reading, fine for writing | **Recommended** |
| RAID 10 | 6 TB | 1 guaranteed (up to 3 if lucky) | Fastest writes | Good, but less space and less safe |

### Recommendation: RAID 6

- **Survives any two drives failing.** Same-age drives tend to fail around the same
  time, and a rebuild after the first failure stresses the others. RAID 6 covers that
  case.
- **8 TB usable** is plenty for websites, email backups, photos and more.
- Websites mostly **read** data, which RAID 6 does quickly.

> **RAID is not a backup.** It protects against a *drive dying*. It does **not**
> protect against deleting a file by mistake, ransomware, a failed RAID card, fire or
> theft. See Part 11.

### Strongly recommended: a UPS

A **UPS** (Uninterruptible Power Supply, e.g. APC Back-UPS 600-850 VA, about $80-130)
is a battery box the server plugs into. It rides through short power blips and
prevents the half-written data that RAID arrays hate. RAID cards and sudden power cuts
are a bad mix.

---

## Part 1: Back up the data on the drives first

You said these drives contain data you want to keep. **Building the RAID wipes all
six drives**, so copy everything off first.

1. Add up how much data is on the six drives.
2. Copy it to another place with enough free space:
   - An external USB drive (a 4-8 TB USB drive is about $90-150)
   - Another computer
   - A cloud service (Google Drive, OneDrive, Backblaze)
3. **Open a few of the copied files** to make sure they work.
4. Write down which drive held what, in case you need to check later.

After the RAID is built and mounted (Part 6), you can copy the data back onto it.

> If the drives are currently in another computer, the simplest way is often to copy
> the data over your home network or to a USB drive from that computer.

---

## Part 2: Check your drives are suitable

Not every hard drive behaves well behind a hardware RAID card.

### 2.1 Read the model number on each drive's label

It looks like `WD20EFRX`, `WD20EFZX`, `WD20EZRZ`, etc.

| Model starts with | Drive family | OK for RAID? |
|---|---|---|
| `WD20EFRX`, `WD20EFZX`, `WD20EFPX` | WD **Red / Red Plus** (CMR) | **Yes**, designed for it |
| `WD2002FFSX`, `WD2005FBYZ`, `WD2000F9YZ` | WD Red Pro / Gold / RE | **Yes**, designed for it |
| `WD20EFAX` | WD Red (**SMR**) | **Avoid if possible**: very slow rebuilds, can drop out of the array |
| `WD20EZRZ`, `WD20EZAZ`, `WD20EARX`, `WD20EZRX` | WD **Blue / Green** (desktop) | **Use with caution**: may be dropped by the card on a slow error |
| `WD20PURX`, `WD20PURZ` | WD **Purple** (surveillance) | Usually works; not ideal |

**Why:** desktop drives (Blue/Green) can spend up to a minute retrying a bad spot.
A RAID card may decide the drive is dead and kick it out. NAS drives (Red/Gold) give up
quickly and let the RAID handle it (a feature called TLER/ERC).

If yours are Blue/Green, it will still work for light use, but:

- Expect more "drive dropped" events over time.
- Plan to replace failed drives with **WD Red Plus** (any size **2 TB or larger** works).
- That's another reason **RAID 6** is the right choice for you.

### 2.2 Check drive health

Old drives may already be failing. In Part 4.3 you can view each drive's
**SMART** health data in the Areca setup screen. **Replace any drive** that shows
non-zero **Reallocated Sector Count**, **Current Pending Sector** or
**Uncorrectable Sector Count**, or that the card marks as failed.

---

## Part 3: Install the card and drives

### 3.1 What you need

- The **ARC-1223-8i** card. It has **two internal mini-SAS connectors** (SFF-8087),
  each serving 4 drives, for 8 drives total.
- **Two "SFF-8087 to 4x SATA forward breakout" cables** (one per 4 drives, about $10-15 each).
  - Make sure they're **forward** breakout (card -> drives), not reverse.
- **SATA power** for all 6 drives (from the power supply, using splitters if needed).
- One **separate SSD** (any 120 GB+ is fine) on a **motherboard** SATA port for Ubuntu.

### 3.2 Install

1. **Shut down and unplug** the server. Touch a metal part of the case to discharge static.
2. Put the card in a **PCIe x8 or x16 slot** (usually the long slot meant for a
   graphics card). The card is PCIe x8.
   - A slot that's physically x16 but electrically x4 also works, just slower.
3. Screw the card's bracket to the case.
4. Connect the breakout cables:
   - Connector 1 (ports 1-4): drives 1-4
   - Connector 2 (ports 5-8): drives 5-6
   - The breakout ends are usually labeled P1, P2, P3, P4.
5. Connect **SATA power** to all six drives.
6. Connect the **Ubuntu SSD** to a **motherboard** SATA port, not the Areca card.
7. **Airflow:** RAID cards run hot. Make sure a case fan blows across the card's heatsink.
   A cheap 80-120 mm fan pointed at it is worth it.

> **Label the drives.** Put a sticker on each drive with its Areca port number (1-6).
> When one fails, you'll know exactly which one to pull.

---

## Part 4: Create the RAID in the Areca setup screen

The Areca card has its own setup program (**McBIOS**) built in. It runs before Ubuntu starts.

### 4.1 Enter McBIOS

1. Connect a monitor and keyboard. Turn the server on.
2. After the motherboard logo, an **Areca** screen lists the controller and drives.
   When it says **"Press Tab/F6 to enter SETUP menu"**, press **Tab** (or **F6**).
3. It asks for a password. The factory default is **`0000`** (four zeros).

Navigation: **arrow keys** move, **Enter** selects, **Esc** goes back.

> No Areca screen at boot? See [Troubleshooting](#troubleshooting).

### 4.2 Look around first

1. **System Information**: note the **firmware version** and whether a **cache memory**
   size and **battery** (BBM) are listed. You need this for 4.6.
2. **Physical Drive Information -> View Drive Information**: you should see all **6**
   drives, each about **2000 GB**. If one is missing, check its cables and power.

### 4.3 Check each drive's health

In **Physical Drive Information -> View Drive Information**, select each drive and look
at its **SMART** values. See Part 2.2 for which values mean "replace this drive".

### 4.4 Remove old RAID or volume sets (if any)

If the drives were used with an Areca card before, old sets may appear.

1. **Volume Set Function -> Delete Volume Set**: delete any listed volume.
2. **Raid Set Function -> Delete Raid Set**: delete any listed RAID set.

Drives that held normal (non-RAID) data simply show as **Free**. That's fine.

### 4.5 Recommended system settings

Open **Raid System Function** and set:

| Setting | Value | Why |
|---|---|---|
| Alert Beeper Setting | **Enabled** | The card beeps loudly if a drive fails |
| Disk Capacity Truncation Mode | **To Multiples of 10G** | A replacement drive that's a few MB smaller will still fit |
| Auto Activate Raid Set | **Enabled** | The array comes back after a reboot even if a drive is missing |
| HDD SMART Status Polling | **Enabled** | Warns about failing drives early |
| Disk Write Cache Mode | **Disabled**, unless you have a UPS | Each drive's own cache is lost in a power cut; disabling it is safer |

Then change the setup password: **Raid System Function -> Change Password**. Write it down.

> Setting names vary slightly between firmware versions. If one isn't there, skip it.

### 4.6 Create the RAID set (groups the drives)

1. **Raid Set Function -> Create Raid Set**.
2. Select **all six** drives: highlight each and press **Enter** to tick it. Press **Esc** when done.
3. Confirm **Yes**. If it asks for a name, use `DATA`.

### 4.7 Create the volume set (the "virtual drive" Ubuntu will see)

1. **Volume Set Function -> Create Volume Set** -> choose the `DATA` RAID set.
2. Set the options (select a field and press **Enter** to change it):

   | Option | Set to | Notes |
   |---|---|---|
   | Volume Name | `DATA-VOL` | Any name |
   | Raid Level | **6** | |
   | Capacity | **Maximum** (about 8000 GB) | |
   | Greater Two TB Volume Support | **64bit LBA** | **Required.** Anything else limits the volume to 2 TB |
   | Initialization Mode | **Background** | You can keep working while it initializes |
   | Stripe Size | **64 KB** (default) | Fine for general use |
   | Cache Mode | **Write-Back** if you have a UPS or the card's battery; otherwise **Write-Through** | Write-Back is faster, but cached data can be lost in a power cut |
   | Tag Queuing | **Enabled** | |
   | SCSI Channel / ID / LUN | Leave the defaults | |

3. Confirm **Yes**.

### 4.8 Let it initialize

**Volume Set Function -> Display Volume Info** shows **Initializing** with a percentage.
On 6 x 2 TB drives, this takes **several hours** (often 4-12).

- You can **continue to Part 5** while it runs (Background mode).
- Avoid heavy use until it reaches **Normal**.
- Leave the server **powered on** until it finishes.

Press **Esc** until it asks to exit, then let the computer restart.

### 4.9 Boot order

Enter the **motherboard** BIOS (usually **Del** or **F2**). Make sure the **Ubuntu SSD**
(or the USB installer, during installation) boots first, **before** the Areca card.

---

## Part 5: Install Ubuntu on the motherboard drive

Follow [SETUP-GUIDE.md Part 2](SETUP-GUIDE.md#part-2-install-ubuntu-server-on-the-home-server),
with one important difference at **step 9 (Guided storage configuration)**:

- The installer lists **two** disks. Pick the **SSD** (its size matches your SSD,
  e.g. 240 GB), **not** the ~8 TB Areca volume.
- If unsure, choose **Custom storage layout** and read the disk names and sizes.
  The Areca volume is the one around **7.3-8.0 TB** (it may be named "Areca" or "ARC-1223").

> Ubuntu includes the driver for Areca cards (`arcmsr`), so there's nothing extra to install.

---

## Part 6: Format and mount the RAID in Ubuntu

Do this after Parts 3-6 of SETUP-GUIDE.md (updates, SSH, firewall). Connect with `ssh frostedharmony`.

### 6.1 Find the RAID volume

```bash
lsmod | grep arcmsr
lsblk -o NAME,SIZE,TYPE,MODEL,MOUNTPOINTS
```

- The first command should print a line containing `arcmsr` (the driver is loaded).
- In the list, the RAID volume is the disk that's about **7.3T** with **no partitions**
  and **no mountpoints**, e.g. `sdb`.
- The SSD is the one with partitions mounted at `/` and `/boot`. **Don't touch that one.**

In the commands below, replace **`sdX`** with your RAID disk (e.g. `sdb`).

> **Triple-check the disk name.** The next commands erase the disk you name.

### 6.2 Create a partition and filesystem

```bash
sudo parted /dev/sdX --script mklabel gpt mkpart data ext4 0% 100%
sudo mkfs.ext4 -L raiddata -m 1 /dev/sdX1
```

- `parted` creates one partition using the whole volume.
- `mkfs.ext4` formats it with the reliable **ext4** filesystem, labeled `raiddata`
  (`-m 1` reserves only 1% of space for emergencies instead of 5%).
- Formatting takes about a minute.

### 6.3 Mount it automatically at `/srv/data`

```bash
sudo mkdir -p /srv/data
sudo blkid /dev/sdX1
```

Copy the `UUID="...."` value (the part inside the quotes). Then edit the mount table:

```bash
sudo nano /etc/fstab
```

Add this line at the bottom, with your UUID:

```
UUID=paste-your-uuid-here  /srv/data  ext4  defaults,nofail,x-systemd.device-timeout=30  0  2
```

- `nofail` means the server still boots, without the RAID, if the card or array has a problem.
- Save (**Ctrl+O**, **Enter**) and exit (**Ctrl+X**).

```bash
sudo systemctl daemon-reload
sudo mount -a
df -h /srv/data
```

`df` should show about **7.3T** mounted on `/srv/data`.

> **Why 7.3T and not 8 TB?** Drive makers count 1 TB = 1,000,000,000,000 bytes; Linux
> counts in powers of 1024 ("TiB"). 8 TB = 7.3 TiB. Nothing is missing.

### 6.4 Create folders and give yourself access

```bash
sudo mkdir -p /srv/data/sites /srv/data/backups /srv/data/files
sudo chown -R $USER:$USER /srv/data/sites /srv/data/backups /srv/data/files
```

### Check

```bash
sudo reboot
```

After reconnecting, `df -h /srv/data` still shows the RAID mounted.

---

## Part 7: Store Docker and the website on the RAID

This puts the website files, the Docker containers and all their data (e.g. downloaded
Instagram photos) on the protected array. It also leaves room for **more websites later**:
each one gets its own folder in `/srv/data/sites/`.

### 7.1 Move Docker's storage to the RAID

Do this after installing Docker ([SETUP-GUIDE.md Part 6](SETUP-GUIDE.md#part-6-install-docker)).
It works whether or not the website is already running.

```bash
cd ~/frostedharmony 2>/dev/null && docker compose down
sudo systemctl stop docker docker.socket
sudo mkdir -p /srv/data/docker
sudo rsync -aHAX /var/lib/docker/ /srv/data/docker/
echo '{ "data-root": "/srv/data/docker" }' | sudo tee /etc/docker/daemon.json
```

Tell Docker to wait for the RAID before starting. Otherwise, if the RAID ever fails to
mount, Docker would quietly start with empty storage on the SSD:

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=/srv/data\n' | sudo tee /etc/systemd/system/docker.service.d/raid.conf
sudo systemctl daemon-reload
sudo mv /var/lib/docker /var/lib/docker.old
sudo systemctl start docker
docker info | grep "Docker Root Dir"
```

You should see `Docker Root Dir: /srv/data/docker`. Run `docker run --rm hello-world` to confirm Docker works.
After a few days with no problems, delete the old copy: `sudo rm -rf /var/lib/docker.old`.

### 7.2 Keep website files on the RAID

**If you already deployed** to `~/frostedharmony`:

```bash
mv ~/frostedharmony /srv/data/sites/
cd /srv/data/sites/frostedharmony
docker compose up -d
```

From now on, deploy from your PC with the `-RemoteDir` option:

```powershell
.\deploy.ps1 -Server frostedharmony -RemoteDir /srv/data/sites/frostedharmony
```

In the main guide, wherever it says `cd ~/frostedharmony`, use
`cd /srv/data/sites/frostedharmony` instead.

> **Adding another website later:** copy this project to a new folder (e.g.
> `C:\Users\dridge\second-site`), deploy it to `/srv/data/sites/second-site`, and in
> Cloudflare add a public hostname for the new domain to the **same tunnel**. Two sites
> can't both publish port `8080`, so ask for help adjusting `docker-compose.yml` at that point.

---

## Part 8: Install the Areca tool and email alerts

The card beeps when a drive fails, but you may not hear it. This part makes the server
**email you** when something's wrong.

### 8.1 Install the Areca command-line tool (cli64)

1. On your PC, go to **https://www.areca.com.tw** -> **Support** -> **Downloads**.
   Find the **RAID controller** utilities and download the **Linux CLI** zip
   (named like `linuxcli_V1.xx_xxxxxx.zip`).
2. Unzip it on your PC. Inside, find the **x86_64** (64-bit) folder containing `cli64`.
3. Copy it to the server (from PowerShell on your PC; adjust the path):

   ```powershell
   scp "$env:USERPROFILE\Downloads\linuxcli\x86_64\cli64" frostedharmony:/tmp/
   ```

4. On the server:

   ```bash
   sudo install -m 755 /tmp/cli64 /usr/local/sbin/cli64
   sudo cli64 vsf info
   ```

   This should list `DATA-VOL`, `Raid6`, about 8000 GB, state `Normal` (or `Initializing`).

Other useful commands:

| Command | Shows |
|---|---|
| `sudo cli64 vsf info` | Volume status (Normal / Initializing / Rebuilding / Degraded) |
| `sudo cli64 rsf info` | RAID set status |
| `sudo cli64 disk info` | Each drive and its state |
| `sudo cli64 hw info` | Card temperature, fans, voltages |
| `sudo cli64 event info` | The card's event history (failures, rebuilds) |

Type `sudo cli64` on its own, then `help`, to see everything; `exit` quits.

### 8.2 Install the alert script

The project includes `server-tools\raid-check.sh`. It checks the RAID every hour and
emails you **once** when a problem starts and **once** when it's fixed.

From PowerShell on your PC:

```powershell
cd C:\Users\dridge\personal-website
scp server-tools\raid-check.sh server-tools\raid-check.conf.example frostedharmony:/tmp/
```

On the server:

```bash
sudo install -m 755 /tmp/raid-check.sh /usr/local/sbin/raid-check.sh
sudo install -m 600 /tmp/raid-check.conf.example /etc/raid-check.conf
sudo nano /etc/raid-check.conf
```

Fill in the Gmail address and App password (the same ones the website uses in `.env`
work fine), and `MAIL_TO` (where alerts go). Save and exit.

Send a test email:

```bash
sudo /usr/local/sbin/raid-check.sh --test
```

You should get an email titled **"RAID test message: status OK"** listing the volume and
drives. (While it's still initializing, the status says PROBLEM. That's expected.)

### 8.3 Run it every hour automatically

```bash
echo '0 * * * * root /usr/local/sbin/raid-check.sh' | sudo tee /etc/cron.d/raid-check
```

You can confirm it runs with `grep raid-check /var/log/syslog`. In newer Ubuntu
versions, use `journalctl -t raid-check` instead.

---

## Part 9: Routine health checks

**Monthly** (2 minutes):

```bash
sudo cli64 vsf info     # State should be Normal
sudo cli64 hw info      # Controller temperature: ideally under about 70 C
df -h /srv/data         # Free space
```

**Every 3 months**, run a **consistency check**. It reads every block and fixes silent
errors before they matter. It's easiest from McBIOS (reboot, press **Tab**):
**Volume Set Function -> Check Volume Set** -> select `DATA-VOL` -> **Yes**. It takes
several hours; the website keeps working, just a bit slower.

---

## Part 10: When a drive fails

The card **beeps**, and you get a **"RAID PROBLEM"** email. With RAID 6 your data is still
safe, but **act within days, not weeks**.

1. **Don't panic, and don't power off repeatedly.**
2. Silence the beeper if needed: McBIOS -> **Raid System Function -> Mute The Alert Beeper**.
3. Find which drive failed:

   ```bash
   sudo cli64 disk info
   ```

   The failed drive shows **Failed** or is missing. Note its port number and match it to your labels (Part 3.2).
4. Buy a replacement **2 TB or larger** drive. **WD Red Plus** is recommended.
5. Shut down: `sudo shutdown now`. Swap the failed drive for the new one on the **same port**. Start the server.
6. The card normally starts **Rebuilding** automatically when it sees a new blank drive.
   - Check with `sudo cli64 vsf info`. It shows **Rebuilding** with a percentage.
   - If it doesn't start, enter McBIOS: **Raid Set Function -> Create Hot Spare**,
     select the new drive. The card then uses it to rebuild.
7. The rebuild takes hours. When the state returns to **Normal**, you'll get a "healthy again" email.

> **Two drives failed?** RAID 6 still has your data, but with zero protection left.
> Replace one drive at a time and let each rebuild finish before replacing the next.
> Avoid heavy use until it's done.

---

## Part 11: Backups (RAID is not a backup)

Follow the **3-2-1 rule** for anything irreplaceable: **3** copies, on **2** kinds of
storage, **1** away from home.

For this server:

- **Website files:** they already live on your PC in `C:\Users\dridge\personal-website`,
  so that's a copy. Also keep a copy in OneDrive or Google Drive.
- **Server secrets** (`.env`, `/etc/raid-check.conf`): store the values in a password manager.
- **Everything else** in `/srv/data` (photos, files): back up to an **external USB drive**
  weekly, plus a cloud backup service (e.g. Backblaze B2 with the free `restic` tool).
  Ask for help when you're ready to set that up.

Simple USB backup example (USB drive mounted at `/media/backup`):

```bash
sudo rsync -a --delete /srv/data/files/ /media/backup/files/
```

---

## Troubleshooting

| Problem | What to try |
|---|---|
| No Areca screen at boot | Reseat the card. Try another PCIe slot. In the motherboard BIOS, enable **Option ROM / Legacy OpROM** for that slot, or set storage to **UEFI** mode. Some boards only show it with **CSM** enabled. |
| A drive is missing in McBIOS | Swap its data cable with a working drive's. If the problem follows the cable, replace the cable; otherwise check that drive's power. |
| Volume is limited to 2 TB | "Greater Two TB Volume Support" wasn't set to **64bit LBA**. Delete the volume and recreate it (this erases it). |
| Ubuntu doesn't show the ~7.3T disk | Run `lsmod \| grep arcmsr`. If it's empty, run `sudo modprobe arcmsr`. Check that the volume is **Normal/Initializing** (not Failed) in McBIOS. |
| Server boots to an emergency prompt after editing `/etc/fstab` | Usually a typo. Log in at the console, run `sudo nano /etc/fstab`, fix or comment out the line with `#`, and reboot. (`nofail` normally prevents this.) |
| Docker won't start | `sudo systemctl status docker`. If it says it's waiting for `/srv/data`, the RAID isn't mounted: run `sudo mount -a` and check `dmesg \| tail -50`. |
| Rebuild is very slow | Normal on SMR/desktop drives; it may take a day or more. Keep load low. |
| Card is very hot (over about 80 C in `cli64 hw info`) | Add a fan blowing directly on the heatsink. |
