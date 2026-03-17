/**
 * Cloudflare Manager - Telegram Bot
 * Manages Cloudflare DNS records via Telegram bot running on CF Workers
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';
const CF_API = 'https://api.cloudflare.com/client/v4';

// Allowed Telegram user IDs (from env)
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
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (keyboard) body.reply_markup = keyboard;
  await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// In-memory session per Worker instance (short-lived, acceptable for low traffic)
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

  // Handle callback queries (inline keyboard)
  if (callbackQuery) {
    const data = callbackQuery.data;

    if (data === 'list_zones') {
      await handleListZones(env, chatId, userId);
    } else if (data.startsWith('zone:')) {
      const zoneId = data.split(':')[1];
      const zoneName = data.split(':')[2];
      setSession(userId, { zoneId, zoneName });
      await handleZoneMenu(env, chatId, zoneName);
    } else if (data === 'list_records') {
      await handleListRecords(env, chatId, userId, session);
    } else if (data === 'add_record') {
      setSession(userId, { step: 'add_type' });
      await sendMessage(env, chatId, 'Enter record <b>type</b> (A, AAAA, CNAME, TXT, MX):');
    } else if (data.startsWith('edit:')) {
      const recId = data.split(':')[1];
      setSession(userId, { step: 'edit_field', editRecordId: recId });
      await sendMessage(env, chatId, 'What to update? Send: <code>name|content|ttl|proxied</code>\nExample: <code>content|1.2.3.4</code>');
    } else if (data.startsWith('del:')) {
      const recId = data.split(':')[1];
      const result = await cfRequest(env, 'DELETE', `/zones/${session.zoneId}/dns_records/${recId}`);
      if (result.success) {
        await sendMessage(env, chatId, '✅ Record deleted.');
      } else {
        await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(result.errors)}`);
      }
    } else if (data === 'main_menu') {
      clearSession(userId);
      await handleStart(env, chatId);
    }
    return;
  }

  const text = update.message?.text?.trim();
  if (!text) return;

  // Step-based flow
  if (session.step === 'add_type') {
    setSession(userId, { step: 'add_name', recType: text.toUpperCase() });
    await sendMessage(env, chatId, 'Enter record <b>name</b> (e.g. sub.example.com or @):');
    return;
  }

  if (session.step === 'add_name') {
    setSession(userId, { step: 'add_content', recName: text });
    await sendMessage(env, chatId, 'Enter record <b>content</b> (e.g. 1.2.3.4):');
    return;
  }

  if (session.step === 'add_content') {
    setSession(userId, { step: 'add_ttl', recContent: text });
    await sendMessage(env, chatId, 'Enter <b>TTL</b> (1 = Auto, or number like 3600):');
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
    clearSession(userId);
    await handleZoneMenu(env, chatId, session.zoneName);
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
      await sendMessage(env, chatId, `✅ Record updated.`);
    } else {
      await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(result.errors)}`);
    }
    clearSession(userId);
    await handleZoneMenu(env, chatId, session.zoneName);
    return;
  }

  // Default: /start or any text at main step
  await handleStart(env, chatId);
}

async function handleStart(env, chatId) {
  const keyboard = {
    inline_keyboard: [[{ text: '🌐 My Domains', callback_data: 'list_zones' }]],
  };
  await sendMessage(env, chatId, '👋 <b>Cloudflare Manager</b>\nSelect an option:', keyboard);
}

async function handleListZones(env, chatId, userId) {
  const result = await cfRequest(env, 'GET', '/zones?per_page=50');
  if (!result.success || !result.result.length) {
    await sendMessage(env, chatId, '❌ No zones found.');
    return;
  }
  const buttons = result.result.map((z) => [{ text: z.name, callback_data: `zone:${z.id}:${z.name}` }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);
  await sendMessage(env, chatId, '🌐 Select a domain:', { inline_keyboard: buttons });
}

async function handleZoneMenu(env, chatId, zoneName) {
  const keyboard = {
    inline_keyboard: [
      [{ text: '📋 List DNS Records', callback_data: 'list_records' }],
      [{ text: '➕ Add DNS Record', callback_data: 'add_record' }],
      [{ text: '🔙 Back to Domains', callback_data: 'list_zones' }],
    ],
  };
  await sendMessage(env, chatId, `🔧 <b>${zoneName}</b>\nChoose action:`, keyboard);
}

async function handleListRecords(env, chatId, userId, session) {
  const result = await cfRequest(env, 'GET', `/zones/${session.zoneId}/dns_records?per_page=50`);
  if (!result.success || !result.result.length) {
    await sendMessage(env, chatId, '❌ No DNS records found.');
    return;
  }
  for (const rec of result.result) {
    const info = `<b>${rec.type}</b> | <code>${rec.name}</code>\n→ <code>${rec.content}</code> | TTL: ${rec.ttl} | Proxied: ${rec.proxied}`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✏️ Edit', callback_data: `edit:${rec.id}` },
          { text: '🗑 Delete', callback_data: `del:${rec.id}` },
        ],
      ],
    };
    await sendMessage(env, chatId, info, keyboard);
  }
  await sendMessage(env, chatId, '─────', {
    inline_keyboard: [[{ text: '🔙 Back', callback_data: `zone:${session.zoneId}:${session.zoneName}` }]],
  });
}

export default {
  async fetch(request, env, ctx) {
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
