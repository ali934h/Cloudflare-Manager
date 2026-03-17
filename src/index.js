/**
 * Cloudflare Manager - Telegram Bot
 * Manages Cloudflare DNS records via Telegram bot running on CF Workers
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';
const CF_API = 'https://api.cloudflare.com/client/v4';

function isAllowed(env, userId) {
  const ids = (env.ALLOWED_IDS || '').split(',').map((id) => id.trim());
  return ids.includes(String(userId));
}

async function cfRequest(env, method, path, body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_TOKEN}`,
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

const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) sessions[userId] = { step: 'main' };
  return sessions[userId];
}

function setSession(userId, data) {
  sessions[userId] = { ...sessions[userId], ...data };
}

function clearSession(userId) {
  sessions[userId] = { step: 'main' };
}

async function handleUpdate(env, update) {
  const msg = update.message || update.callback_query?.message;
  const callbackQuery = update.callback_query;
  const userId = update.message?.from?.id || callbackQuery?.from?.id;
  const chatId = msg?.chat?.id;

  if (!userId || !chatId) return;
  if (!isAllowed(env, userId)) {
    await sendMessage(env, chatId, '⛔ Unauthorized');
    return;
  }

  const session = getSession(userId);

  if (callbackQuery) {
    await answerCallback(env, callbackQuery.id);
    const data = callbackQuery.data;

    if (data === 'list_zones') {
      await handleListZones(env, chatId);

    } else if (data.startsWith('zone:')) {
      const parts = data.split(':');
      const zoneId = parts[1];
      const zoneName = parts.slice(2).join(':');
      setSession(userId, { zoneId, zoneName });
      await handleZoneMenu(env, chatId, zoneId, zoneName);

    } else if (data.startsWith('records:')) {
      const parts = data.split(':');
      const zoneId = parts[1];
      const zoneName = parts.slice(2).join(':');
      setSession(userId, { zoneId, zoneName });
      await handleListRecords(env, chatId, zoneId, zoneName);

    } else if (data.startsWith('addrec:')) {
      const parts = data.split(':');
      const zoneId = parts[1];
      const zoneName = parts.slice(2).join(':');
      setSession(userId, { step: 'add_type', zoneId, zoneName });
      await sendMessage(env, chatId, 'Enter record <b>type</b>:\n<code>A, AAAA, CNAME, TXT, MX, NS, SRV, CAA</code>');

    } else if (data.startsWith('recinfo:')) {
      // recinfo:<recId>:<zoneId>:<zoneName>
      // Fetch record directly from CF API
      const parts = data.split(':');
      const recId = parts[1];
      const zoneId = parts[2];
      const zoneName = parts.slice(3).join(':');
      const result = await cfRequest(env, 'GET', `/zones/${zoneId}/dns_records/${recId}`);
      if (!result.success) {
        await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(result.errors)}`);
        return;
      }
      const rec = result.result;
      const proxiedIcon = rec.proxied ? '🟠' : '⚪️';
      const info = `${proxiedIcon} <b>${rec.type}</b>\nName: <code>${rec.name}</code>\nContent: <code>${rec.content}</code>\nTTL: ${rec.ttl} | Proxied: ${rec.proxied}`;
      await sendMessage(env, chatId, info, {
        inline_keyboard: [
          [
            { text: '✏️ Edit', callback_data: `edit:${rec.id}:${zoneId}:${zoneName}` },
            { text: '🗑 Delete', callback_data: `del:${rec.id}:${zoneId}:${zoneName}` },
          ],
          [{ text: '🔙 Back to list', callback_data: `records:${zoneId}:${zoneName}` }],
        ],
      });

    } else if (data.startsWith('edit:')) {
      const parts = data.split(':');
      const recId = parts[1];
      const zoneId = parts[2];
      const zoneName = parts.slice(3).join(':');
      setSession(userId, { step: 'edit_field', editRecordId: recId, zoneId, zoneName });
      await sendMessage(env, chatId, 'What to update? Send: <code>field|value</code>\nFields: <code>name</code>, <code>content</code>, <code>ttl</code>, <code>proxied</code>\nExample: <code>content|1.2.3.4</code>');

    } else if (data.startsWith('del:')) {
      const parts = data.split(':');
      const recId = parts[1];
      const zoneId = parts[2];
      const zoneName = parts.slice(3).join(':');
      const result = await cfRequest(env, 'DELETE', `/zones/${zoneId}/dns_records/${recId}`);
      if (result.success) {
        await sendMessage(env, chatId, '✅ Record deleted.');
      } else {
        await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(result.errors)}`);
      }
      await handleZoneMenu(env, chatId, zoneId, zoneName);

    } else if (data === 'main_menu') {
      clearSession(userId);
      await handleStart(env, chatId);
    }
    return;
  }

  const text = update.message?.text?.trim();
  if (!text) return;

  if (session.step === 'add_type') {
    setSession(userId, { step: 'add_name', recType: text.toUpperCase() });
    await sendMessage(env, chatId, 'Enter record <b>name</b> (e.g. <code>sub.example.com</code> or <code>@</code>):');
    return;
  }

  if (session.step === 'add_name') {
    setSession(userId, { step: 'add_content', recName: text });
    await sendMessage(env, chatId, 'Enter record <b>content</b> (e.g. <code>1.2.3.4</code>):');
    return;
  }

  if (session.step === 'add_content') {
    setSession(userId, { step: 'add_ttl', recContent: text });
    await sendMessage(env, chatId, 'Enter <b>TTL</b> (<code>1</code> = Auto, or number like <code>3600</code>):');
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
      await sendMessage(env, chatId, `✅ Record added:\n<code>${session.recType} ${session.recName} → ${session.recContent}</code>`);
    } else {
      await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(result.errors)}`);
    }
    const { zoneId, zoneName } = session;
    clearSession(userId);
    await handleZoneMenu(env, chatId, zoneId, zoneName);
    return;
  }

  if (session.step === 'edit_field') {
    const parts = text.split('|');
    if (parts.length !== 2) {
      await sendMessage(env, chatId, '❌ Invalid format. Use: <code>field|value</code>');
      return;
    }
    const [field, value] = parts;
    const patch = {};
    if (field === 'ttl') patch.ttl = parseInt(value);
    else if (field === 'proxied') patch.proxied = value === 'true';
    else patch[field] = value;

    const result = await cfRequest(env, 'PATCH', `/zones/${session.zoneId}/dns_records/${session.editRecordId}`, patch);
    if (result.success) {
      await sendMessage(env, chatId, '✅ Record updated.');
    } else {
      await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(result.errors)}`);
    }
    const { zoneId, zoneName } = session;
    clearSession(userId);
    await handleZoneMenu(env, chatId, zoneId, zoneName);
    return;
  }

  await handleStart(env, chatId);
}

async function handleStart(env, chatId) {
  const keyboard = {
    inline_keyboard: [[{ text: '🌐 My Domains', callback_data: 'list_zones' }]],
  };
  await sendMessage(env, chatId, '👋 <b>Cloudflare Manager</b>\nSelect an option:', keyboard);
}

async function handleListZones(env, chatId) {
  const result = await cfRequest(env, 'GET', '/zones?per_page=50');
  if (!result.success || !result.result?.length) {
    await sendMessage(env, chatId, `❌ No zones found.\n<code>${JSON.stringify(result.errors)}</code>`);
    return;
  }
  const buttons = result.result.map((z) => [{ text: z.name, callback_data: `zone:${z.id}:${z.name}` }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);
  await sendMessage(env, chatId, '🌐 Select a domain:', { inline_keyboard: buttons });
}

async function handleZoneMenu(env, chatId, zoneId, zoneName) {
  const keyboard = {
    inline_keyboard: [
      [{ text: '📋 List DNS Records', callback_data: `records:${zoneId}:${zoneName}` }],
      [{ text: '➕ Add DNS Record', callback_data: `addrec:${zoneId}:${zoneName}` }],
      [{ text: '🔙 Back to Domains', callback_data: 'list_zones' }],
    ],
  };
  await sendMessage(env, chatId, `🔧 <b>${zoneName}</b>\nChoose action:`, keyboard);
}

async function handleListRecords(env, chatId, zoneId, zoneName) {
  const result = await cfRequest(env, 'GET', `/zones/${zoneId}/dns_records?per_page=100`);

  if (!result.success) {
    await sendMessage(env, chatId, `❌ CF API Error:\n<code>${JSON.stringify(result.errors)}</code>`);
    return;
  }

  if (!result.result || result.result.length === 0) {
    await sendMessage(env, chatId, '❌ No DNS records found.', {
      inline_keyboard: [[{ text: '➕ Add Record', callback_data: `addrec:${zoneId}:${zoneName}` }]],
    });
    return;
  }

  const lines = result.result.map((rec, i) => {
    const icon = rec.proxied ? '🟠' : '⚪️';
    return `${i + 1}. ${icon} <b>${rec.type}</b> <code>${rec.name}</code>\n    → <code>${rec.content}</code>`;
  });

  const text = `📋 <b>DNS Records — ${zoneName}</b> (${result.result.length})\n\n${lines.join('\n\n')}`;

  // Each record gets a button that fetches it fresh from CF API
  const buttons = result.result.map((rec, i) => [
    { text: `${i + 1}. ${rec.type} — ${rec.name}`, callback_data: `recinfo:${rec.id}:${zoneId}:${zoneName}` },
  ]);
  buttons.push([{ text: '➕ Add Record', callback_data: `addrec:${zoneId}:${zoneName}` }]);
  buttons.push([{ text: '🔙 Back', callback_data: `zone:${zoneId}:${zoneName}` }]);

  await sendMessage(env, chatId, text, { inline_keyboard: buttons });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/debug') {
      const result = await cfRequest(env, 'GET', '/zones/56d436913fe5c605d4fe40d10cefac09/dns_records?per_page=10');
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
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
