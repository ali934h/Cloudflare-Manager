# Cloudflare Manager Bot

A Telegram bot to manage Cloudflare DNS records and SSL/TLS settings, running on Cloudflare Workers.

---

## Prerequisites

- [Node.js](https://nodejs.org) v18+
- A [Cloudflare account](https://cloudflare.com)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/ali934h/Cloudflare-Manager.git
cd Cloudflare-Manager
npm install
```

### 2. Login to Wrangler

```bash
npx wrangler login
```

### 3. Configure `wrangler.jsonc`

Open `wrangler.jsonc` and set your worker name if needed.

### 4. Set secrets

```bash
npx wrangler secret put BOT_TOKEN       # Telegram bot token
npx wrangler secret put CF_API_KEY      # Cloudflare Global API Key
npx wrangler secret put CF_EMAIL        # Cloudflare account email
npx wrangler secret put ALLOWED_IDS     # Telegram user ID(s), comma-separated (e.g. 12345678,87654321)
```

> **Where to find these:**
> - `BOT_TOKEN` → [@BotFather](https://t.me/BotFather) → `/newbot`
> - `CF_API_KEY` → [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) → **API Keys** → **Global API Key** → View
> - `CF_EMAIL` → Your Cloudflare account email
> - `ALLOWED_IDS` → Your Telegram user ID from [@userinfobot](https://t.me/userinfobot)

### 5. Deploy

```bash
npm run deploy
```

Copy the Worker URL from the output (e.g. `https://cloudflare-manager.<your-subdomain>.workers.dev`)

### 6. Register bot commands

Open this URL once in your browser:

```
https://cloudflare-manager.<your-subdomain>.workers.dev/setup
```

### 7. Set Telegram webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://cloudflare-manager.<your-subdomain>.workers.dev"
```

### 8. Start the bot

Open your bot in Telegram and send `/start`.

---

## Updating

```bash
git pull
npm run deploy
```

Secrets are preserved between deploys — no need to re-enter them.

---

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Main menu |
| `/domains` | List all domains |
| `/help` | Usage guide |
| `/cancel` | Cancel current action |
