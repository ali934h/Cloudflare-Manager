# Cloudflare Manager

A serverless Telegram bot running on Cloudflare Workers to manage DNS records.

## Features
- List all Cloudflare zones (domains)
- List DNS records per zone
- Add DNS record
- Edit DNS record (name, content, ttl, proxied)
- Delete DNS record

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Set secrets via Wrangler
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put CF_TOKEN
npx wrangler secret put ALLOWED_IDS
```
> `ALLOWED_IDS`: comma-separated Telegram user IDs, e.g. `77933874,8261361884`

### 3. Deploy
```bash
npm run deploy
```

### 4. Set Telegram Webhook
Replace `YOUR_WORKER_URL` with the deployed worker URL:
```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=YOUR_WORKER_URL
```

### 5. Local development
```bash
npm run dev
```
Use [ngrok](https://ngrok.com/) or similar to expose local port and set as webhook for testing.
