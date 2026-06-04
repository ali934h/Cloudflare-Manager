/**
 * Cloudflare Manager - Telegram Bot
 * Manages Cloudflare DNS records via Telegram bot running on CF Workers
 *
 * Required environment variables (secrets):
 *   BOT_TOKEN   — Telegram bot token from @BotFather
 *   CF_API_KEY  — Cloudflare Global API Key
 *   CF_EMAIL    — Cloudflare account email
 *   ALLOWED_IDS — Comma-separated Telegram user IDs allowed to use the bot
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';
const CF_API = 'https://api.cloudflare.com/client/v4';

const PROXYABLE_TYPES = ['A', 'AAAA', 'CNAME'];

function isAllowed(env, userId) {
  const ids = (env.ALLOWED_IDS || '').split(',').map((id) => id.trim());
  return ids.includes(String(userId));
}

async function cfRequest(env, method, path, body = null) {
  const opts = {
    method,
    headers: {
      'X-Auth-Key': env.CF_API_KEY,
      'X-Auth-Email': env.CF_EMAIL,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${CF_API}${path}`, opts);
  return res.json();
}

async function sendMessage(env, chatId, text, keyboard = null) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = keyboard;
  await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function answerCallback(env, callbackQueryId, text = '') {
  await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function setMyCommands(env) {
  await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start',      description: '🌐 Main menu' },
        { command: 'domains',    description: '🗂 List all domains' },
        { command: 'addfast',    description: '⚡ Add DNS record(s) in one message' },
        { command: 'removefast', description: '🗑 Delete DNS record(s) in one message' },
        { command: 'help',       description: '❓ How to use this bot' },
        { command: 'cancel',     description: '❌ Cancel current action' },
      ],
    }),
  });
}

const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) sessions[userId] = {};
  return sessions[userId];
}

function setSession(userId, data) {
  sessions[userId] = { ...sessions[userId], ...data };
}

function resetStep(userId) {
  const s = sessions[userId] || {};
  sessions[userId] = { zoneId: s.zoneId, zoneName: s.zoneName, records: s.records };
}

function sid(id) {
  return id.slice(0, 16);
}

/**
 * Cloudflare stores record names as full FQDNs (e.g. "mysub.example.com").
 * When the user types a short name like "mysub" or "@", we expand it here
 * so the API name filter actually matches.
 */
function expandName(name, domain) {
  if (name === '@' || name === domain) return domain;
  if (name.endsWith('.' + domain) || name.endsWith('.')) return name;
  return `${name}.${domain}`;
}

const SSL_MODES = {
  off:      { label: '🔴 Off',           desc: 'No SSL — HTTP only' },
  flexible: { label: '🟡 Flexible',      desc: 'SSL to visitor, HTTP to origin' },
  full:     { label: '🟢 Full',          desc: 'SSL to visitor and origin (self-signed ok)' },
  strict:   { label: '🔵 Full (Strict)', desc: 'SSL with valid certificate on origin' },
};

const TLS_VERSIONS = {
  '1.0': { label: 'TLS 1.0', desc: 'Oldest — not recommended' },
  '1.1': { label: 'TLS 1.1', desc: 'Legacy — not recommended' },
  '1.2': { label: 'TLS 1.2', desc: 'Widely supported — recommended minimum' },
  '1.3': { label: 'TLS 1.3', desc: 'Latest — fastest & most secure' },
};

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseAddFastLine(input) {
  const parts = input.split('|').map((p) => p.trim());
  if (parts.length !== 6) {
    return { error: `Invalid format (expected 6 fields): <code>${input}</code>` };
  }

  const [domain, rawType, name, content, rawTtl, rawProxied] = parts;

  if (!domain || !domain.includes('.')) return { error: `Invalid domain: <code>${domain}</code>` };

  const validTypes = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];
  const type = rawType.toUpperCase();
  if (!validTypes.includes(type)) return { error: `Invalid record type: <code>${rawType}</code>` };
  if (!name) return { error: 'Name is required.' };
  if (!content) return { error: 'Content is required.' };

  const ttl = parseInt(rawTtl);
  if (isNaN(ttl) || ttl < 1) return { error: `Invalid TTL: <code>${rawTtl}</code>` };

  const proxiedLower = rawProxied.toLowerCase();
  if (!['proxied', 'direct', 'true', 'false'].includes(proxiedLower)) {
    return { error: `Invalid proxy value: <code>${rawProxied}</code> — use <code>proxied</code> or <code>direct</code>` };
  }
  const proxied = proxiedLower === 'proxied' || proxiedLower === 'true';

  if (proxied && !PROXYABLE_TYPES.includes(type)) {
    return { error: `Type <code>${type}</code> does not support proxy — use <code>direct</code>` };
  }

  return { domain, type, name, content, ttl, proxied };
}

function parseRemoveFastLine(input) {
  const parts = input.split('|').map((p) => p.trim());
  if (parts.length !== 4) {
    return { error: `Invalid format (expected 4 fields): <code>${input}</code>` };
  }

  const [domain, rawType, name, content] = parts;

  if (!domain || !domain.includes('.')) return { error: `Invalid domain: <code>${domain}</code>` };

  const validTypes = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];
  const type = rawType.toUpperCase();
  if (!validTypes.includes(type)) return { error: `Invalid record type: <code>${rawType}</code>` };
  if (!name) return { error: 'Name is required.' };
  if (!content) return { error: 'Content is required.' };

  return { domain, type, name, content };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleAddFastCommand(env, chatId) {
  await sendMessage(env, chatId,
    '⚡ <b>Add DNS Record(s)</b>\n\n' +
    'Send one or more lines, each in this format:\n' +
    '<code>domain | type | name | content | ttl | proxied</code>\n\n' +
    '📌 <b>Fields explained:</b>\n' +
    '• <b>domain</b> — your Cloudflare domain (must be in your account)\n' +
    '• <b>type</b> — record type: A, AAAA, CNAME, TXT, MX, NS, SRV, CAA\n' +
    '• <b>name</b> — subdomain or <code>@</code> for root\n' +
    '• <b>content</b> — IP address, hostname, or text value\n' +
    '• <b>ttl</b> — <code>1</code> for Auto, or seconds like <code>3600</code>\n' +
    '• <b>proxied</b> — <code>proxied</code> or <code>direct</code> (only A, AAAA, CNAME support proxy)\n\n' +
    '📋 <b>Examples:</b>\n\n' +
    '<code>example.com | A | @ | 1.2.3.4 | 1 | proxied</code>\n' +
    '→ Root A record, proxied\n\n' +
    '<code>example.com | A | sub | 1.2.3.4 | 1 | direct</code>\n' +
    '→ Subdomain A record, not proxied\n\n' +
    '<code>example.com | AAAA | ipv6sub | 2001:db8::1 | 1 | proxied</code>\n' +
    '→ IPv6 record, proxied\n\n' +
    '<code>example.com | CNAME | www | target.example.net | 1 | proxied</code>\n' +
    '→ CNAME pointing to another host\n\n' +
    '<code>example.com | TXT | @ | v=spf1 include:_spf.example.com ~all | 1 | direct</code>\n' +
    '→ SPF TXT record (TXT cannot be proxied)\n\n' +
    '<code>example.com | MX | @ | mail.example.com | 3600 | direct</code>\n' +
    '→ MX record with custom TTL\n\n' +
    '<code>example.com | NS | sub | ns1.example.com | 3600 | direct</code>\n' +
    '→ NS delegation record\n\n' +
    '/cancel to abort',
    { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'main_menu' }]] },
  );
}

async function handleAddFastInput(env, chatId, userId, text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  if (lines.length === 1) {
    const parsed = parseAddFastLine(lines[0]);
    if (parsed.error) {
      await sendMessage(env, chatId,
        `❌ ${parsed.error}\n\nFormat: <code>domain | type | name | content | ttl | proxied</code>\n\n/addfast to see examples`,
      );
      return;
    }
  }

  const results = [];

  for (const line of lines) {
    const parsed = parseAddFastLine(line);
    if (parsed.error) {
      results.push(`❌ ${parsed.error}`);
      continue;
    }

    const { domain, type, name, content, ttl, proxied } = parsed;

    const zonesResult = await cfRequest(env, 'GET', `/zones?name=${encodeURIComponent(domain)}&per_page=5`);
    if (!zonesResult.success || !zonesResult.result?.length) {
      results.push(`❌ Domain not found: <code>${domain}</code>`);
      continue;
    }
    const zone = zonesResult.result[0];

    const createResult = await cfRequest(env, 'POST', `/zones/${zone.id}/dns_records`, {
      type, name, content, ttl, proxied,
    });

    if (!createResult.success) {
      const msg = createResult.errors?.map((e) => e.message).join(', ') || JSON.stringify(createResult.errors);
      results.push(`❌ <b>${type}</b> <code>${name}</code> → <i>${msg}</i>`);
    } else {
      const rec = createResult.result;
      const proxiedIcon = proxied ? '🟠' : '⚪️';
      results.push(`✅ ${proxiedIcon} <b>${rec.type}</b> <code>${rec.name}</code> → <code>${rec.content}</code>`);
    }
  }

  await sendMessage(env, chatId,
    `<b>Add Fast — ${lines.length} record(s)</b>\n\n${results.join('\n')}`,
    {
      inline_keyboard: [
        [{ text: '⚡ Add More', callback_data: 'addfast_prompt' }],
        [{ text: '🏠 Main Menu', callback_data: 'main_menu' }],
      ],
    },
  );

  resetStep(userId);
}

async function handleRemoveFastCommand(env, chatId) {
  await sendMessage(env, chatId,
    '🗑 <b>Remove DNS Record(s)</b>\n\n' +
    'Send one or more lines, each in this format:\n' +
    '<code>domain | type | name | content</code>\n\n' +
    '📌 <b>Fields explained:</b>\n' +
    '• <b>domain</b> — your Cloudflare domain (must be in your account)\n' +
    '• <b>type</b> — record type: A, AAAA, CNAME, TXT, MX, NS, SRV, CAA\n' +
    '• <b>name</b> — subdomain or <code>@</code> for root\n' +
    '• <b>content</b> — exact IP, hostname, or text value of the record\n\n' +
    '⚠️ The record must match exactly to be found. Deleted immediately — no confirmation.\n\n' +
    '📋 <b>Examples:</b>\n\n' +
    '<code>example.com | A | @ | 1.2.3.4</code>\n' +
    '→ Delete root A record\n\n' +
    '<code>example.com | A | sub | 1.2.3.4</code>\n' +
    '→ Delete subdomain A record\n\n' +
    '<code>example.com | AAAA | ipv6sub | 2001:db8::1</code>\n' +
    '→ Delete IPv6 record\n\n' +
    '<code>example.com | CNAME | www | target.example.net</code>\n' +
    '→ Delete CNAME record\n\n' +
    '<code>example.com | TXT | @ | v=spf1 include:_spf.example.com ~all</code>\n' +
    '→ Delete TXT/SPF record\n\n' +
    '<code>example.com | MX | @ | mail.example.com</code>\n' +
    '→ Delete MX record\n\n' +
    '<code>example.com | NS | sub | ns1.example.com</code>\n' +
    '→ Delete NS delegation record\n\n' +
    '/cancel to abort',
    { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'main_menu' }]] },
  );
}

async function handleRemoveFastInput(env, chatId, userId, text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    const parsed = parseRemoveFastLine(line);
    if (parsed.error) {
      results.push(`❌ ${parsed.error}`);
      continue;
    }

    const { domain, type, name, content } = parsed;

    // Resolve zone
    const zonesResult = await cfRequest(env, 'GET', `/zones?name=${encodeURIComponent(domain)}&per_page=5`);
    if (!zonesResult.success || !zonesResult.result?.length) {
      results.push(`❌ Domain not found: <code>${domain}</code>`);
      continue;
    }
    const zone = zonesResult.result[0];

    // Expand short name to full FQDN so the CF API filter matches
    const fullName = expandName(name, domain);

    const recordsResult = await cfRequest(env, 'GET',
      `/zones/${zone.id}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(fullName)}&per_page=100`,
    );

    if (!recordsResult.success) {
      results.push(`❌ Failed to fetch records for <code>${domain}</code>`);
      continue;
    }

    const match = recordsResult.result?.find(
      (r) => r.content.toLowerCase() === content.toLowerCase(),
    );

    if (!match) {
      results.push(`❌ Not found: <b>${type}</b> <code>${fullName}</code> → <code>${content}</code>`);
      continue;
    }

    const deleteResult = await cfRequest(env, 'DELETE', `/zones/${zone.id}/dns_records/${match.id}`);
    if (deleteResult.success) {
      results.push(`✅ Deleted: <b>${match.type}</b> <code>${match.name}</code> → <code>${match.content}</code>`);
    } else {
      const msg = deleteResult.errors?.map((e) => e.message).join(', ') || JSON.stringify(deleteResult.errors);
      results.push(`❌ Delete failed: <b>${type}</b> <code>${fullName}</code> → <i>${msg}</i>`);
    }
  }

  await sendMessage(env, chatId,
    `<b>Remove Fast — ${lines.length} record(s)</b>\n\n${results.join('\n')}`,
    {
      inline_keyboard: [
        [{ text: '🗑 Remove More', callback_data: 'removefast_prompt' }],
        [{ text: '🏠 Main Menu', callback_data: 'main_menu' }],
      ],
    },
  );

  resetStep(userId);
}

// ---------------------------------------------------------------------------
// Update router
// ---------------------------------------------------------------------------

async function handleUpdate(env, update) {
  const msg = update.message || update.callback_query?.message;
  const callbackQuery = update.callback_query;
  const userId = update.message?.from?.id || callbackQuery?.from?.id;
  const chatId = msg?.chat?.id;

  if (!userId || !chatId) return;
  if (!isAllowed(env, userId)) {
    await sendMessage(env, chatId, '⛔ <b>Access Denied</b>\nYou are not authorized to use this bot.');
    return;
  }

  const session = getSession(userId);

  if (callbackQuery) {
    await answerCallback(env, callbackQuery.id);
    const data = callbackQuery.data;

    if (data === 'main_menu') {
      sessions[userId] = {};
      await handleStart(env, chatId);

    } else if (data === 'list_zones') {
      await handleListZones(env, chatId);

    } else if (data === 'domains_raw') {
      await handleDomainsRaw(env, chatId);

    } else if (data === 'help') {
      await handleHelp(env, chatId);

    } else if (data === 'addfast_prompt') {
      setSession(userId, { step: 'addfast' });
      await handleAddFastCommand(env, chatId);

    } else if (data === 'removefast_prompt') {
      setSession(userId, { step: 'removefast' });
      await handleRemoveFastCommand(env, chatId);

    } else if (data.startsWith('zone:')) {
      const parts = data.split(':');
      const zoneId = parts[1];
      const zoneName = parts.slice(2).join(':');
      sessions[userId] = { zoneId, zoneName };
      await handleZoneMenu(env, chatId, zoneId, zoneName);

    } else if (data === 'zone_menu') {
      await handleZoneMenu(env, chatId, session.zoneId, session.zoneName);

    } else if (data === 'records') {
      if (!session.zoneId) { await sendMessage(env, chatId, '❌ Session lost. Please use /start again.'); return; }
      await handleListRecords(env, chatId, userId, session.zoneId, session.zoneName);

    } else if (data === 'addrec') {
      setSession(userId, { step: 'add_type' });
      await sendMessage(env, chatId, '➕ <b>Add DNS Record</b>\n\nSend the record <b>type</b>:\n<code>A  AAAA  CNAME  TXT  MX  NS  SRV  CAA</code>\n\n/cancel to abort');

    } else if (data === 'ssl_menu') {
      if (!session.zoneId) { await sendMessage(env, chatId, '❌ Session lost. Please use /start again.'); return; }
      await handleSslMenu(env, chatId, session.zoneId, session.zoneName);

    } else if (data.startsWith('ssl_set:')) {
      await handleSslSet(env, chatId, session.zoneId, session.zoneName, data.slice(8));

    } else if (data === 'tls_menu') {
      if (!session.zoneId) { await sendMessage(env, chatId, '❌ Session lost. Please use /start again.'); return; }
      await handleTlsMenu(env, chatId, session.zoneId, session.zoneName);

    } else if (data.startsWith('tls_set:')) {
      await handleTlsSet(env, chatId, session.zoneId, session.zoneName, data.slice(8));

    } else if (data.startsWith('ri:')) {
      const shortId = data.slice(3);
      let rec = session.records?.find((r) => r.id.startsWith(shortId));
      if (!rec && session.zoneId) {
        const fresh = await cfRequest(env, 'GET', `/zones/${session.zoneId}/dns_records?per_page=100`);
        if (fresh.success) {
          setSession(userId, { records: fresh.result });
          rec = fresh.result?.find((r) => r.id.startsWith(shortId));
        }
      }
      if (!rec) {
        await sendMessage(env, chatId, '❌ Record not found. Please refresh.', {
          inline_keyboard: [[{ text: '🔄 Refresh list', callback_data: 'records' }]],
        });
        return;
      }
      setSession(userId, { editRecordId: rec.id });
      const proxiedIcon = rec.proxied ? '🟠 Proxied' : '⚪️ Direct';
      await sendMessage(env, chatId,
        `📌 <b>Record Details</b>\n\nType: <b>${rec.type}</b>\nName: <code>${rec.name}</code>\nContent: <code>${rec.content}</code>\nTTL: <code>${rec.ttl === 1 ? 'Auto' : rec.ttl}</code>\nStatus: ${proxiedIcon}`,
        {
          inline_keyboard: [
            [{ text: '✏️ Edit', callback_data: 'edit_rec' }, { text: '🗑 Delete', callback_data: `delconfirm:${shortId}` }],
            [{ text: '🔙 Back to list', callback_data: 'records' }],
          ],
        },
      );

    } else if (data === 'edit_rec') {
      setSession(userId, { step: 'edit_field' });
      await sendMessage(env, chatId,
        '✏️ <b>Edit Record</b>\n\nSend: <code>field|value</code>\n\nEditable fields:\n• <code>content|1.2.3.4</code>\n• <code>name|sub.example.com</code>\n• <code>ttl|3600</code> (or <code>1</code> for Auto)\n• <code>proxied|true</code> or <code>proxied|false</code>\n\n/cancel to abort',
      );

    } else if (data.startsWith('delconfirm:')) {
      const shortId = data.slice(11);
      const rec = session.records?.find((r) => r.id.startsWith(shortId));
      setSession(userId, { pendingDeleteId: shortId });
      await sendMessage(env, chatId,
        `⚠️ <b>Confirm Delete</b>\n\nAre you sure you want to delete:\n<code>${rec?.name || 'this record'}</code>`,
        {
          inline_keyboard: [[
            { text: '✅ Yes, delete', callback_data: `dr:${shortId}` },
            { text: '❌ Cancel', callback_data: 'records' },
          ]],
        },
      );

    } else if (data.startsWith('dr:')) {
      const shortId = data.slice(3);
      const rec = session.records?.find((r) => r.id.startsWith(shortId));
      const recId = rec?.id || session.editRecordId;
      const { zoneId, zoneName } = session;
      const result = await cfRequest(env, 'DELETE', `/zones/${zoneId}/dns_records/${recId}`);
      if (result.success) {
        await sendMessage(env, chatId, '✅ <b>Record deleted successfully.</b>');
      } else {
        await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(result.errors)}`);
      }
      resetStep(userId);
      await handleZoneMenu(env, chatId, zoneId, zoneName);
    }
    return;
  }

  // Text commands
  const text = update.message?.text?.trim();
  if (!text) return;

  if (text === '/start') { sessions[userId] = {}; await handleStart(env, chatId); return; }
  if (text === '/help') { await handleHelp(env, chatId); return; }
  if (text === '/domains') { await handleListZones(env, chatId); return; }
  if (text === '/addfast') {
    setSession(userId, { step: 'addfast' });
    await handleAddFastCommand(env, chatId);
    return;
  }
  if (text === '/removefast') {
    setSession(userId, { step: 'removefast' });
    await handleRemoveFastCommand(env, chatId);
    return;
  }
  if (text === '/cancel') {
    resetStep(userId);
    if (session.zoneId) await handleZoneMenu(env, chatId, session.zoneId, session.zoneName);
    else await handleStart(env, chatId);
    return;
  }

  if (session.step === 'addfast') {
    await handleAddFastInput(env, chatId, userId, text);
    return;
  }

  if (session.step === 'removefast') {
    await handleRemoveFastInput(env, chatId, userId, text);
    return;
  }

  if (session.step === 'add_type') {
    const validTypes = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];
    const recType = text.toUpperCase();
    if (!validTypes.includes(recType)) {
      await sendMessage(env, chatId, `❌ Invalid type. Choose from:\n<code>${validTypes.join('  ')}</code>`);
      return;
    }
    setSession(userId, { step: 'add_name', recType });
    await sendMessage(env, chatId, `✅ Type: <b>${recType}</b>\n\nNow enter the record <b>name</b>:\n<code>sub.example.com</code> or <code>@</code> for root\n\n/cancel to abort`);
    return;
  }

  if (session.step === 'add_name') {
    setSession(userId, { step: 'add_content', recName: text });
    await sendMessage(env, chatId, `✅ Name: <code>${text}</code>\n\nNow enter the record <b>content</b>:\n(e.g. IP address, hostname, or text value)\n\n/cancel to abort`);
    return;
  }

  if (session.step === 'add_content') {
    setSession(userId, { step: 'add_ttl', recContent: text });
    await sendMessage(env, chatId, `✅ Content: <code>${text}</code>\n\nEnter <b>TTL</b>:\n<code>1</code> = Auto (recommended)\nor a number like <code>3600</code>\n\n/cancel to abort`);
    return;
  }

  if (session.step === 'add_ttl') {
    const ttl = parseInt(text) || 1;
    const result = await cfRequest(env, 'POST', `/zones/${session.zoneId}/dns_records`, {
      type: session.recType,
      name: session.recName,
      content: session.recContent,
      ttl,
      proxied: false,
    });
    if (result.success) {
      await sendMessage(env, chatId,
        `✅ <b>Record Added Successfully</b>\n\nType: <b>${session.recType}</b>\nName: <code>${session.recName}</code>\nContent: <code>${session.recContent}</code>\nTTL: <code>${ttl === 1 ? 'Auto' : ttl}</code>`,
      );
    } else {
      await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(result.errors)}`);
    }
    const { zoneId, zoneName } = session;
    resetStep(userId);
    await handleZoneMenu(env, chatId, zoneId, zoneName);
    return;
  }

  if (session.step === 'edit_field') {
    const parts = text.split('|');
    if (parts.length !== 2) {
      await sendMessage(env, chatId, '❌ Invalid format.\nUse: <code>field|value</code>\nExample: <code>content|1.2.3.4</code>');
      return;
    }
    const [field, value] = parts;
    const patch = {};
    if (field === 'ttl') patch.ttl = parseInt(value);
    else if (field === 'proxied') patch.proxied = value === 'true';
    else patch[field] = value;
    const result = await cfRequest(env, 'PATCH', `/zones/${session.zoneId}/dns_records/${session.editRecordId}`, patch);
    if (result.success) {
      await sendMessage(env, chatId, `✅ <b>Record updated successfully.</b>\n<code>${field}</code> → <code>${value}</code>`);
    } else {
      await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(result.errors)}`);
    }
    const { zoneId, zoneName } = session;
    resetStep(userId);
    await handleZoneMenu(env, chatId, zoneId, zoneName);
    return;
  }

  await handleStart(env, chatId);
}

// ---------------------------------------------------------------------------
// UI handlers
// ---------------------------------------------------------------------------

async function handleStart(env, chatId) {
  await sendMessage(env, chatId,
    '👋 <b>Cloudflare Manager</b>\n\nManage your Cloudflare DNS records right from Telegram.\n\nWhat would you like to do?',
    {
      inline_keyboard: [
        [{ text: '🗂 My Domains', callback_data: 'list_zones' }],
        [{ text: '⚡ Add Fast', callback_data: 'addfast_prompt' }, { text: '🗑 Remove Fast', callback_data: 'removefast_prompt' }],
        [{ text: '❓ Help', callback_data: 'help' }],
      ],
    },
  );
}

async function handleHelp(env, chatId) {
  await sendMessage(env, chatId,
    '❓ <b>Cloudflare Manager — Help</b>\n\n' +
    '<b>Commands:</b>\n' +
    '/start — Main menu\n' +
    '/domains — List domains\n' +
    '/addfast — Add DNS record(s) in one message\n' +
    '/removefast — Delete DNS record(s) in one message\n' +
    '/help — This help\n' +
    '/cancel — Cancel action\n\n' +
    '<b>Add Fast format (one or more lines):</b>\n' +
    '<code>domain | type | name | content | ttl | proxied</code>\n\n' +
    '<b>Remove Fast format (one or more lines):</b>\n' +
    '<code>domain | type | name | content</code>\n\n' +
    '<b>SSL/TLS Modes:</b>\n🔴 Off — HTTP only\n🟡 Flexible — HTTPS to visitor only\n🟢 Full — HTTPS both sides\n🔵 Strict — valid cert required\n\n' +
    '<b>Min TLS Version:</b>\nRecommended: TLS 1.2 or 1.3\n\n' +
    '<b>Edit DNS record:</b>\nSend <code>field|value</code> e.g. <code>content|1.2.3.4</code>',
    { inline_keyboard: [[{ text: '🗂 Go to Domains', callback_data: 'list_zones' }]] },
  );
}

async function handleListZones(env, chatId) {
  const result = await cfRequest(env, 'GET', '/zones?per_page=50');
  if (!result.success || !result.result?.length) {
    await sendMessage(env, chatId, `❌ No domains found.\n<code>${JSON.stringify(result.errors)}</code>`);
    return;
  }
  const buttons = result.result.map((z) => [{ text: `🌐 ${z.name}`, callback_data: `zone:${z.id}:${z.name}` }]);
  buttons.push([
    { text: '📋 Raw List', callback_data: 'domains_raw' },
    { text: '🔙 Back',     callback_data: 'main_menu' },
  ]);
  await sendMessage(env, chatId,
    `🗂 <b>Your Domains</b> (${result.result.length})\n\nSelect a domain to manage:`,
    { inline_keyboard: buttons },
  );
}

async function handleDomainsRaw(env, chatId) {
  const result = await cfRequest(env, 'GET', '/zones?per_page=50');
  if (!result.success || !result.result?.length) {
    await sendMessage(env, chatId, `❌ No domains found.\n<code>${JSON.stringify(result.errors)}</code>`);
    return;
  }
  const list = result.result.map((z) => z.name).join('\n');
  await sendMessage(env, chatId,
    `🗂 <b>All Domains</b> (${result.result.length})\n\n<pre>${list}</pre>`,
    { inline_keyboard: [[{ text: '🔙 Back to Domains', callback_data: 'list_zones' }]] },
  );
}

async function handleZoneMenu(env, chatId, zoneId, zoneName) {
  await sendMessage(env, chatId, `🌐 <b>${zoneName}</b>\n\nWhat would you like to do?`, {
    inline_keyboard: [
      [{ text: '📋 List DNS Records', callback_data: 'records' }],
      [{ text: '➕ Add DNS Record', callback_data: 'addrec' }],
      [{ text: '🔒 SSL/TLS Mode', callback_data: 'ssl_menu' }, { text: '🛡 TLS Version', callback_data: 'tls_menu' }],
      [{ text: '🔙 Back to Domains', callback_data: 'list_zones' }],
    ],
  });
}

async function handleSslMenu(env, chatId, zoneId, zoneName) {
  const result = await cfRequest(env, 'GET', `/zones/${zoneId}/settings/ssl`);
  const current = result.success ? result.result?.value : null;
  const currentLabel = SSL_MODES[current]?.label || current || 'Unknown';

  const buttons = Object.entries(SSL_MODES).map(([mode, { label }]) => [{
    text: mode === current ? `✅ ${label} (current)` : label,
    callback_data: `ssl_set:${mode}`,
  }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'zone_menu' }]);

  await sendMessage(env, chatId,
    `🔒 <b>SSL/TLS Mode — ${zoneName}</b>\n\nCurrent: <b>${currentLabel}</b>\n\n🔴 <b>Off</b> — HTTP only\n🟡 <b>Flexible</b> — HTTPS to visitor, HTTP to origin\n🟢 <b>Full</b> — HTTPS end-to-end (self-signed ok)\n🔵 <b>Full (Strict)</b> — valid cert required\n\nSelect a mode:`,
    { inline_keyboard: buttons },
  );
}

async function handleSslSet(env, chatId, zoneId, zoneName, mode) {
  if (!SSL_MODES[mode]) { await sendMessage(env, chatId, '❌ Invalid SSL mode.'); return; }
  const result = await cfRequest(env, 'PATCH', `/zones/${zoneId}/settings/ssl`, { value: mode });
  if (result.success) {
    const { label, desc } = SSL_MODES[mode];
    await sendMessage(env, chatId, `✅ <b>SSL mode updated</b>\nDomain: <b>${zoneName}</b>\nMode: <b>${label}</b>\n<i>${desc}</i>`);
  } else {
    await sendMessage(env, chatId, `❌ Failed:\n<code>${JSON.stringify(result.errors)}</code>`);
  }
  await handleSslMenu(env, chatId, zoneId, zoneName);
}

async function handleTlsMenu(env, chatId, zoneId, zoneName) {
  const result = await cfRequest(env, 'GET', `/zones/${zoneId}/settings/min_tls_version`);
  const current = result.success ? result.result?.value : null;
  const currentLabel = TLS_VERSIONS[current]?.label || current || 'Unknown';

  const buttons = Object.entries(TLS_VERSIONS).map(([ver, { label }]) => [{
    text: ver === current ? `✅ ${label} (current)` : label,
    callback_data: `tls_set:${ver}`,
  }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'zone_menu' }]);

  await sendMessage(env, chatId,
    `🛡 <b>Minimum TLS Version — ${zoneName}</b>\n\nCurrent: <b>${currentLabel}</b>\n\n<b>TLS 1.0</b> — Oldest, not recommended\n<b>TLS 1.1</b> — Legacy, not recommended\n<b>TLS 1.2</b> — Recommended minimum\n<b>TLS 1.3</b> — Latest, fastest & most secure\n\nSelect minimum version:`,
    { inline_keyboard: buttons },
  );
}

async function handleTlsSet(env, chatId, zoneId, zoneName, ver) {
  if (!TLS_VERSIONS[ver]) { await sendMessage(env, chatId, '❌ Invalid TLS version.'); return; }
  const result = await cfRequest(env, 'PATCH', `/zones/${zoneId}/settings/min_tls_version`, { value: ver });
  if (result.success) {
    const { label, desc } = TLS_VERSIONS[ver];
    await sendMessage(env, chatId, `✅ <b>TLS version updated</b>\nDomain: <b>${zoneName}</b>\nMin TLS: <b>${label}</b>\n<i>${desc}</i>`);
  } else {
    await sendMessage(env, chatId, `❌ Failed:\n<code>${JSON.stringify(result.errors)}</code>`);
  }
  await handleTlsMenu(env, chatId, zoneId, zoneName);
}

async function handleListRecords(env, chatId, userId, zoneId, zoneName) {
  const result = await cfRequest(env, 'GET', `/zones/${zoneId}/dns_records?per_page=100`);
  if (!result.success) {
    await sendMessage(env, chatId, `❌ CF API Error:\n<code>${JSON.stringify(result.errors)}</code>`);
    return;
  }
  if (!result.result || result.result.length === 0) {
    await sendMessage(env, chatId, '❌ No DNS records found.', {
      inline_keyboard: [
        [{ text: '➕ Add Record', callback_data: 'addrec' }],
        [{ text: '🔙 Back', callback_data: 'zone_menu' }],
      ],
    });
    return;
  }
  setSession(userId, { records: result.result });
  const typeIcon = { A: '🟦', AAAA: '🟦', CNAME: '🔗', TXT: '📝', MX: '📧', NS: '📍', SRV: '⚙️', CAA: '🔒' };
  const lines = result.result.map((rec, i) => {
    const icon = typeIcon[rec.type] || '🟦';
    const proxied = rec.proxied ? ' 🟠' : '';
    return `${i + 1}. ${icon} <b>${rec.type}</b>${proxied} <code>${rec.name}</code>\n    → <code>${rec.content}</code>`;
  });
  const buttons = result.result.map((rec, i) => [
    { text: `${i + 1}. ${rec.type} — ${rec.name}`, callback_data: `ri:${sid(rec.id)}` },
  ]);
  buttons.push([{ text: '➕ Add Record', callback_data: 'addrec' }, { text: '🔄 Refresh', callback_data: 'records' }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'zone_menu' }]);
  await sendMessage(env, chatId,
    `📋 <b>${zoneName}</b>\n${result.result.length} record(s)\n\n${lines.join('\n\n')}`,
    { inline_keyboard: buttons },
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/setup') {
      await setMyCommands(env);
      return new Response('Commands registered!');
    }

    if (request.method !== 'POST') return new Response('OK');

    try {
      const update = await request.json();
      ctx.waitUntil(handleUpdate(env, update));
    } catch (e) {
      console.error(e);
    }

    return new Response('OK');
  },
};
