# Email Setup: cupcakes@frostedharmony.com

This sets up a professional email address, **cupcakes@frostedharmony.com**, for free,
using the Gmail account your wife already has:

- **Receiving:** mail sent to `cupcakes@frostedharmony.com` arrives in her Gmail inbox
  (Cloudflare Email Routing forwards it).
- **Sending:** in Gmail (web or phone), she can pick `cupcakes@frostedharmony.com` as the
  **From** address.
- **Website inquiries** are delivered to the same place.

**Cost:** $0. Nothing extra runs on your server.

---

## Why not run a mail server at home?

Xfinity residential internet **blocks port 25**, the port mail servers use to exchange
email. A home mail server couldn't reliably send or receive. Even where it isn't
blocked, Gmail and Outlook treat mail from home IP addresses as spam. Forwarding avoids
all of that while still giving you the professional address.

```
Customer --> cupcakes@frostedharmony.com --> Cloudflare Email Routing --> her Gmail inbox
Her Gmail --(From: cupcakes@frostedharmony.com)--> Customer
```

---

## Before you start

- `frostedharmony.com` must already be **Active on Cloudflare**
  ([SETUP-GUIDE.md Part 8](SETUP-GUIDE.md#part-8-point-your-wix-domain-to-cloudflare-and-create-the-tunnel)).
- Your wife's Gmail address (below, `her.name@gmail.com`).
- A second email account for testing (yours works).

---

## Part 1: Turn on Cloudflare Email Routing (receiving)

1. Log in to **https://dash.cloudflare.com** and click **frostedharmony.com**.
2. In the left menu, open **Email** -> **Email Routing** (in some dashboards:
   **Email -> Email Routing -> Get started**).
3. **Create a custom address:**
   - Custom address: `cupcakes` (the `@frostedharmony.com` part is filled in)
   - Action: **Send to an email**
   - Destination: `her.name@gmail.com`
   - Click **Create and continue**.
4. Cloudflare emails a verification link to `her.name@gmail.com`. **Open it and click
   "Verify email address"**. Forwarding won't work until this is done.
5. Back in Cloudflare, it offers to **Add records and enable**. Click it. This
   automatically adds:
   - 3 **MX** records (`route1/2/3.mx.cloudflare.net`), which tell the internet where to deliver your mail
   - 1 **TXT** SPF record (`v=spf1 include:_spf.mx.cloudflare.net ~all`)
   - A DKIM TXT record
6. If it warns about **existing MX records** (for example left over from Wix), let it
   remove them, unless you're using another mailbox service. You aren't, per this plan.

**Optional (catch-all):** under **Routing rules**, enable **Catch-all address** ->
**Send to an email** -> her Gmail. Then *anything*@frostedharmony.com (orders@, hello@,
typos) reaches her too. It's handy, but it can attract a little more spam.

**Adding more addresses later** (e.g. `orders@`): **Email Routing -> Routing rules ->
Create address**. Each one can go to a different Gmail.

---

## Part 2: Create a Gmail App password (for sending)

Gmail needs permission to send as the new address. It uses an **App password**, a
16-letter password just for this purpose.

Signed in to **her Gmail account**:

1. Go to **https://myaccount.google.com/security** and make sure **2-Step Verification** is **On**.
2. Go to **https://myaccount.google.com/apppasswords**.
3. Name: `Send as cupcakes@frostedharmony.com` -> **Create**.
4. **Copy the 16-letter password.** It's shown once. You'll paste it in Part 3.

---

## Part 3: Add "Send mail as" in Gmail

Do this on a **computer** (gmail.com in a browser). The setting can't be added from the phone app.

1. Open **https://mail.google.com** signed in as her.
2. Click the **gear** (top right) -> **See all settings** -> **Accounts and Import** tab
   (it's called **Accounts** on some accounts).
3. Under **Send mail as**, click **Add another email address**.
4. In the popup:
   - Name: `Frosted Harmony` (what customers see)
   - Email address: `cupcakes@frostedharmony.com`
   - Leave **Treat as an alias** ticked.
   - Click **Next Step**.
5. SMTP settings:

   | Field | Value |
   |---|---|
   | SMTP Server | `smtp.gmail.com` |
   | Port | `587` |
   | Username | `her.name@gmail.com` (her full Gmail address) |
   | Password | the 16-letter App password from Part 2 |
   | Security | **Secured connection using TLS** (recommended) |

   Click **Add Account**.
6. Gmail sends a **confirmation code** to `cupcakes@frostedharmony.com`. Thanks to Part 1,
   it lands in her inbox within a minute. Paste the code into the popup -> **Verify**.
7. Back in **Accounts and Import -> Send mail as**, choose these options:
   - Next to `cupcakes@frostedharmony.com`, click **make default** if most of her email should come from it.
   - **When replying to a message:** select **Reply from the same address the message was sent to**.

---

## Part 4: Add a DMARC record (helps delivery)

DMARC tells other email providers how to treat mail claiming to be from your domain.
Start in "monitor only" mode:

1. Cloudflare -> **frostedharmony.com** -> **DNS** -> **Records** -> **Add record**.
2. Fill in:

   | Type | Name | Content |
   |---|---|---|
   | TXT | `_dmarc` | `v=DMARC1; p=none;` |

3. **Save**.

> **Keep it at `p=none`.** Mail sent through Gmail's "Send mail as" is signed by
> gmail.com, not by frostedharmony.com. A stricter policy (`quarantine` or `reject`)
> would tell other providers to junk her own outgoing mail. For better alignment, see
> [Optional upgrade](#optional-upgrade-better-deliverability-for-sent-mail).

---

## Part 5: Test it

**Use a different email account for testing** (e.g. your own). Gmail hides messages you
send to yourself through a forward, so testing from her own Gmail looks broken even when
it works.

1. **Receiving:** from your account, send a message to `cupcakes@frostedharmony.com`.
   It should appear in her Gmail within a minute (check Spam the first time).
2. **Replying:** open that message in her Gmail and click **Reply**. The **From** line
   should show `cupcakes@frostedharmony.com`. Send it.
3. In **your** account, open the reply:
   - It should come from `Frosted Harmony <cupcakes@frostedharmony.com>`.
   - In Gmail, click the three dots -> **Show original** to see delivery details.
     Outlook may show "sent on behalf of"; that's normal for this setup.
4. **New message:** in her Gmail, click **Compose**, click the **From** field, choose
   `cupcakes@frostedharmony.com`, and send to yourself.

### On her phone

In the **Gmail app**, when composing or replying, tap the **From** line to choose
`cupcakes@frostedharmony.com`. Once Part 3 is done on the computer, it appears automatically.

---

## Part 6: Connect the website's inquiry form

On the server, set where website inquiries go:

```bash
cd ~/frostedharmony        # or /srv/data/sites/frostedharmony if you followed RAID-SETUP.md Part 7
nano .env
```

Set:

```
MAIL_TO=cupcakes@frostedharmony.com
```

Save, exit, and apply:

```bash
docker compose up -d
```

Inquiry emails now arrive in her inbox addressed to `cupcakes@`. When she clicks
**Reply**, it goes to the **customer**, and with "reply from the same address" (Part 3,
step 7) it's sent **from** `cupcakes@frostedharmony.com`.

> The site's contact section shows `cupcakes@frostedharmony.com` as a clickable link, so
> customers can email directly instead of using the form.

---

## Optional upgrade: better deliverability for sent mail

For a small bakery, the setup above usually works well. If replies often land in
customers' **spam** folders, send through a free **SMTP relay** that signs mail as
`frostedharmony.com`:

1. Sign up for a relay with a free tier, such as **SMTP2GO** (about 1,000 emails/month)
   or **Brevo** (about 300/day).
2. In the relay's dashboard, **add the domain** `frostedharmony.com`. It gives you
   2-3 DNS records (DKIM CNAME/TXT, and sometimes a return-path CNAME). Add them in
   Cloudflare -> **DNS -> Records** exactly as shown, with **Proxy status: DNS only** (grey cloud).
3. If the relay asks you to add something to SPF, **edit the existing SPF TXT record**
   rather than adding a second one (a domain may only have **one** SPF record), e.g.
   `v=spf1 include:_spf.mx.cloudflare.net include:spf.smtp2go.com ~all`.
4. Create SMTP credentials in the relay.
5. In Gmail -> **Accounts and Import -> Send mail as**, click **edit info** next to
   `cupcakes@frostedharmony.com` -> **Next Step** and replace the SMTP server, port,
   username and password with the relay's values.
6. After a week of good results, you can tighten DMARC to `v=DMARC1; p=quarantine;`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Mail to `cupcakes@` never arrives | Cloudflare -> Email Routing: is the **destination verified**? Is routing **enabled**? Under **DNS -> Records**, are there exactly the 3 Cloudflare MX records? Check Gmail's **Spam**. |
| Gmail says "verification code" email never came | Part 1 must be working first. Test by emailing `cupcakes@` from another account. |
| "Authentication failed" when adding Send-as | Use the **App password**, not her normal password, and her **full** Gmail address as username. 2-Step Verification must be on. |
| Testing from her own Gmail shows nothing | Expected. Test from a different account (see Part 5). |
| Replies land in the customer's spam | Check the DMARC record exists. Consider the [Optional upgrade](#optional-upgrade-better-deliverability-for-sent-mail). |
| "Duplicate SPF record" warning | Merge into **one** TXT record starting `v=spf1` that includes every service. |
| Cloudflare Email Routing activity | **Email -> Email Routing -> Activity log** shows each forwarded or rejected message. |
