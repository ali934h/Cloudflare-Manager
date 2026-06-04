# Cloudflare Manager Bot

A Telegram bot to manage your Cloudflare DNS records and SSL/TLS settings, running entirely on Cloudflare Workers — no server required.

**Features:** list domains · add/edit/delete DNS records · change SSL mode · set minimum TLS version · quick one-line record creation

---

## Setup

### 1. Create a Telegram bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the steps.
3. Copy the **bot token** you receive.

### 2. Get your Telegram user ID

1. Message [@userinfobot](https://t.me/userinfobot).
2. It will reply with your numeric user ID (e.g. `123456789`).
3. Save it — you will need it as `ALLOWED_IDS`.

> To allow multiple users, separate IDs with commas: `123456789,987654321`

### 3. Get your Cloudflare credentials

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com).
2. Click your profile icon (top right) → **My Profile**.
3. Go to **API Tokens** → scroll down to **API Keys** → **Global API Key** → **View**.
4. Copy the key and note the email address of your Cloudflare account.

### 4. Create a Cloudflare Worker

1. In the Cloudflare dashboard, go to **Workers & Pages** → **Create** → **Workers** → **Start from Hello World!**
2. Name it (e.g. `cloudflare-manager`) and click **Deploy**.
3. Click **Edit code** to open the in-browser editor.

### 5. Paste the bot code

1. Open [`cloudflare-manager.js`](cloudflare-manager.js) in this repo and click **Raw**, then copy all the content.
2. In the Cloudflare editor, replace the entire default code with what you copied.
3. Click **Deploy** (top right).

### 6. Configure runtime settings

In your Worker page → **Settings** → **Runtime**:

- Set **Compatibility date** to `2026-03-10` or later.
- Add `nodejs_compat` to **Compatibility flags**.

Click **Save**.

### 7. Add secrets

In your Worker page → **Settings** → **Variables and Secrets** → **Add variable**.

Add each of the following as **Type: Secret**:

| Name | Value |
|------|-------|
| `BOT_TOKEN` | Telegram bot token from step 1 |
| `CF_API_KEY` | Cloudflare Global API Key from step 3 |
| `CF_EMAIL` | Your Cloudflare account email |
| `ALLOWED_IDS` | Your Telegram user ID from step 2 |

Click **Deploy** after adding all secrets.

### 8. Register bot commands

Open this URL once in your browser (replace the host with your Worker URL shown at the top of the Worker page):

```
https://cloudflare-manager.<your-subdomain>.workers.dev/setup
```

You should see: `Commands registered!`

### 9. Set the Telegram webhook

Open this URL once in your browser (replace `<BOT_TOKEN>` and the Worker URL):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://cloudflare-manager.<your-subdomain>.workers.dev
```

You should see: `{"ok":true,...,"description":"Webhook was set"}`

> **Note:** `bot` must be written directly before the token — no space or slash.

### 10. Start the bot

Open your bot in Telegram and send `/start`.

---

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Main menu |
| `/domains` | List all your Cloudflare domains |
| `/quickadd` | Add a DNS record in one line |
| `/help` | Usage guide |
| `/cancel` | Cancel current action |

---

## Quick Add

The `/quickadd` command lets you add a DNS record in a single message.

**Format:**
```
domain | type | name | content | ttl | proxied
```

**Fields:**

| Field | Description | Example |
|-------|-------------|---------|
| `domain` | Your Cloudflare domain | `example.com` |
| `type` | Record type | `A`, `AAAA`, `CNAME`, `TXT`, `MX`, `NS`, `SRV`, `CAA` |
| `name` | Subdomain or `@` for root | `sub`, `@`, `www` |
| `content` | IP, hostname, or text value | `1.2.3.4` |
| `ttl` | `1` for Auto, or seconds | `1`, `3600` |
| `proxied` | `proxied` or `direct` | `proxied` |

> Only `A`, `AAAA`, and `CNAME` records support `proxied`. All others must use `direct`.

**Examples:**
```
example.com | A | @ | 1.2.3.4 | 1 | proxied
example.com | CNAME | www | target.example.net | 1 | proxied
example.com | TXT | @ | v=spf1 include:_spf.example.com ~all | 1 | direct
example.com | MX | @ | mail.example.com | 3600 | direct
```

---

## Updating

1. Open your Worker in the Cloudflare dashboard → **Edit code**.
2. Replace the code with the latest contents of [`cloudflare-manager.js`](cloudflare-manager.js).
3. Click **Deploy**.

Secrets, compatibility flags, and the webhook do not need to be reconfigured.

---

## Troubleshooting

**Bot replies "Access Denied"**
Your Telegram user ID is not in `ALLOWED_IDS`. Double-check the value you set in the Worker secrets.

**"Unauthorized to access requested resource"**
`CF_API_KEY` or `CF_EMAIL` is wrong. Make sure you used the **Global API Key** (not an API Token) and the correct email.

**"Session lost. Please use /start again."**
The Worker restarted and cleared the in-memory session. Send `/start`, select your domain again, and continue.

**Webhook not working**
Make sure the webhook URL exactly matches your Worker URL, and that `bot` is written directly before the token with no spaces.
