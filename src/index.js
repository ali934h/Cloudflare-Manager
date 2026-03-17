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
  if (!sessions[userId]) sessions[userId] = {};
  return sessions[userId];
}

function setSession(userId, data) {
  sessions[userId] = { ...sessions[userId], ...data };
}

function resetStep(userId) {
  // Only reset the step, keep zoneId/zoneName/records
  const s = sessions[userId] || {};
  sessions[userId] = {
    zoneId: s.zoneId,
    zoneName: s.zoneName,
    records: s.records,
  };
}

// First 16 chars of an ID for short callback_data
function sid(id) {
  return id.slice(0, 16);
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

    if (data === 'main_menu') {
      sessions[userId] = {};
      await handleStart(env, chatId);

    } else if (data === 'list_zones') {
      await handleListZones(env, chatId);

    } else if (data.startsWith('zone:')) {
      const parts = data.split(':');
      const zoneId = parts[1];
      const zoneName = parts.slice(2).join(':');
      sessions[userId] = { zoneId, zoneName };
      await handleZoneMenu(env, chatId, zoneId, zoneName);

    } else if (data === 'zone_menu') {
      const { zoneId, zoneName } = session;
      await handleZoneMenu(env, chatId, zoneId, zoneName);

    } else if (data === 'records') {
      const { zoneId, zoneName } = session;
      if (!zoneId) {
        await sendMessage(env, chatId, '❌ Session lost. Please /start again.');
        return;
      }
      await handleListRecords(env, chatId, userId, zoneId, zoneName);

    } else if (data === 'addrec') {
      setSession(userId, { step: 'add_type' });
      await sendMessage(env, chatId, 'Enter record <b>type</b>:\n<code>A, AAAA, CNAME, TXT, MX, NS, SRV, CAA</code>');

    } else if (data.startsWith('ri:')) {
      // ri:<sid(recId)> — find in session or re-fetch
      const shortId = data.slice(3);
      let rec = session.records?.find((r) => r.id.startsWith(shortId));

      if (!rec) {
        // Re-fetch records from CF API
        const { zoneId } = session;
        if (!zoneId) {
          await sendMessage(env, chatId, '❌ Session lost. Please /start again.');
          return;
        }
        const fresh = await cfRequest(env, 'GET', `/zones/${zoneId}/dns_records?per_page=100`);
        if (fresh.success) {
          setSession(userId, { records: fresh.result });
          rec = fresh.result?.find((r) => r.id.startsWith(shortId));
        }
      }

      if (!rec) {
        await sendMessage(env, chatId, '❌ Record not found. Please refresh the list.', {
          inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'records' }]],
        });
        return;
      }

      setSession(userId, { editRecordId: rec.id });
      const proxiedIcon = rec.proxied ? '🟠' : '⚪️';
      const info = `${proxiedIcon} <b>${rec.type}</b>\nName: <code>${rec.name}</code>\nContent: <code>${rec.content}</code>\nTTL: ${rec.ttl} | Proxied: ${rec.proxied}`;
      await sendMessage(env, chatId, info, {
        inline_keyboard: [
          [
            { text: '✏️ Edit', callback_data: 'edit_rec' },
            { text: '🗑 Delete', callback_data: `dr:${shortId}` },
          ],
          [{ text: '🔙 Back to list', callback_data: 'records' }],
        ],
      });

    } else if (data === 'edit_rec') {
      setSession(userId, { step: 'edit_field' });
      await sendMessage(env, chatId, 'Send: <code>field|value</code>\nFields: <code>name</code>, <code>content</code>, <code>ttl</code>, <code>proxied</code>\nExample: <code>content|1.2.3.4</code>');

    } else if (data.startsWith('dr:')) {
      const shortId = data.slice(3);
      const rec = session.records?.find((r) => r.id.startsWith(shortId));
      const recId = rec?.id || session.editRecordId;
      const { zoneId, zoneName } = session;
      const result = await cfRequest(env, 'DELETE', `/zones/${zoneId}/dns_records/${recId}`);
      if (result.success) {
        await sendMessage(env, chatId, '✅ Record deleted.');
      } else {
        await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(result.errors)}`);
      }
      resetStep(userId);
      await handleZoneMenu(env, chatId, zoneId, zoneName);
    }
    return;
  }

  const text = update.message?.text?.trim();
  if (!text) return;

  if (text === '/start') {
    sessions[userId] = {};
    await handleStart(env, chatId);
    return;
  }

  if (session.step === 'add_type') {
    setSession(userId, { step: 'add_name', recType: text.toUpperCase() });
    await sendMessage(env, chatId, 'Enter record <b>name</b> (e.g. <code>sub.example.com</code>):');
    return;
  }

  if (session.step === 'add_name') {
    setSession(userId, { step: 'add_content', recName: text });
    await sendMessage(env, chatId, 'Enter record <b>content</b>:');
    return;
  }

  if (session.step === 'add_content') {
    setSession(userId, { step: 'add_ttl', recContent: text });
    await sendMessage(env, chatId, 'Enter <b>TTL</b> (<code>1</code> = Auto):');
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
      await sendMessage(env, chatId, `✅ Added: <code>${session.recType} ${session.recName} → ${session.recContent}</code>`);
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
      await sendMessage(env, chatId, '❌ Invalid. Use: <code>field|value</code>');
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
    resetStep(userId);
    await handleZoneMenu(env, chatId, zoneId, zoneName);
    return;
  }

  await handleStart(env, chatId);
}

async function handleStart(env, chatId) {
  await sendMessage(env, chatId, '👋 <b>Cloudflare Manager</b>\nSelect an option:', {
    inline_keyboard: [[{ text: '🌐 My Domains', callback_data: 'list_zones' }]],
  });
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
  await sendMessage(env, chatId, `🔧 <b>${zoneName}</b>\nChoose action:`, {
    inline_keyboard: [
      [{ text: '📋 List DNS Records', callback_data: 'records' }],
      [{ text: '➕ Add DNS Record', callback_data: 'addrec' }],
      [{ text: '🔙 Back to Domains', callback_data: 'list_zones' }],
    ],
  });
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

  const lines = result.result.map((rec, i) => {
    const icon = rec.proxied ? '🟠' : '⚪️';
    return `${i + 1}. ${icon} <b>${rec.type}</b> <code>${rec.name}</code>\n    → <code>${rec.content}</code>`;
  });

  const text = `📋 <b>${zoneName}</b> — ${result.result.length} record(s)\n\n${lines.join('\n\n')}`;

  const buttons = result.result.map((rec, i) => [
    { text: `${i + 1}. ${rec.type} — ${rec.name}`, callback_data: `ri:${sid(rec.id)}` },
  ]);
  buttons.push([{ text: '➕ Add Record', callback_data: 'addrec' }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'zone_menu' }]);

  await sendMessage(env, chatId, text, { inline_keyboard: buttons });
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
