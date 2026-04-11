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

### 2. Create a Cloudflare API Token

1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token** → **Edit Cloudflare Workers** (use template)
3. Click **Continue to summary** → **Create Token**
4. Copy the token

### 3. Set the deploy token

```bash
set CLOUDFLARE_API_TOKEN=your_token_here
```

> To make it permanent: add it to Windows **Environment Variables** (User variables).

### 4. Set secrets

```bash
npx wrangler secret put BOT_TOKEN       # Telegram bot token
npx wrangler secret put CF_API_KEY      # Cloudflare Global API Key
npx wrangler secret put CF_EMAIL        # Cloudflare account email
npx wrangler secret put ALLOWED_IDS     # Telegram user ID(s), comma-separated
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

> **Note:** `bot` must be written directly before the token with no space or slash.

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
| `/quickadd` | Add a DNS record in one line |
| `/help` | Usage guide |
| `/cancel` | Cancel current action |

---

## Quick Add DNS Record

The `/quickadd` command lets you add a DNS record in a single message without going through the step-by-step flow.

### Format

```
domain | type | name | content | ttl | proxied
```

### Fields

| Field | Description | Example |
|-------|-------------|---------|
| `domain` | Your Cloudflare domain (must exist in your account) | `example.com` |
| `type` | Record type | `A`, `AAAA`, `CNAME`, `TXT`, `MX`, `NS`, `SRV`, `CAA` |
| `name` | Subdomain or `@` for root | `sub`, `@`, `www` |
| `content` | IP address, hostname, or text value | `1.2.3.4` |
| `ttl` | `1` for Auto, or seconds | `1`, `3600` |
| `proxied` | `proxied` or `direct` | `proxied` |

> **Note:** Only `A`, `AAAA`, and `CNAME` records support `proxied`. All other types must use `direct`.

### Examples

```
example.com | A | @ | 1.2.3.4 | 1 | proxied
example.com | A | sub | 1.2.3.4 | 1 | direct
example.com | AAAA | ipv6sub | 2001:db8::1 | 1 | proxied
example.com | CNAME | www | target.example.net | 1 | proxied
example.com | TXT | @ | v=spf1 include:_spf.example.com ~all | 1 | direct
example.com | MX | @ | mail.example.com | 3600 | direct
example.com | NS | sub | ns1.example.com | 3600 | direct
```

---

## Troubleshooting

### `fetch failed` or `Connect Timeout Error` during deploy

Wrangler cannot reach Cloudflare servers. This is a network/VPN issue.

**Fix:** Enable your VPN or proxy before running `npm run deploy`.

If you use Git Bash on Windows, you can set up proxy shortcuts using this guide:  
🔗 [proxy-guide-git-bash](https://github.com/ali934h/proxy-guide-git-bash)

```bash
proxy-on
npm run deploy
proxy-off
```

---

### `You are logged in with an API Token. Unset the CLOUDFLARE_API_TOKEN`

Wrangler found an old OAuth session conflicting with your token.

**Fix:** Delete the old config file:

```
C:\Users\<you>\AppData\Roaming\xdg.config\.wrangler\config\default.toml
```

Then create a new `default.toml` with:

```toml
api_token = "your_api_token_here"
```

Then set the environment variable and deploy:

```bash
set CLOUDFLARE_API_TOKEN=your_api_token_here
npm run deploy
```

---

### `OAuth redirect` never returns to terminal

The `wrangler login` browser flow requires `localhost:8976` to be reachable. On restricted networks this fails.

**Fix:** Skip OAuth entirely — use an API Token instead (see step 2 above).  
Create `default.toml` manually as described above.

---

### `Unauthorized to access requested resource` in bot

The `CF_API_KEY` or `CF_EMAIL` secret is wrong or missing.

**Fix:**
```bash
npx wrangler secret put CF_API_KEY
npx wrangler secret put CF_EMAIL
```

Make sure you use the **Global API Key** (not an API Token) for `CF_API_KEY`.

---

### `Could not route to /zones/undefined/dns_records`

Session was lost (Worker restarted and in-memory session cleared).

**Fix:** Send `/start`, select your domain again, then continue.

---

### `curl: (35) schannel: ... CRYPT_E_REVOCATION_OFFLINE`

SSL certificate revocation check failed — usually a network/VPN issue.

**Fix:** Enable your proxy first, then retry:

```bash
proxy-on
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://..."
```

Alternatively, open the webhook URL directly in your browser.
