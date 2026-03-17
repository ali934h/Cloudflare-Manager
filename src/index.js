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

async function setMyCommands(env) {
  await fetch(`${TELEGRAM_API}${env.BOT_TOKEN}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start', description: '🌐 Main menu' },
        { command: 'domains', description: '🗂 List all domains' },
        { command: 'help', description: '❓ How to use this bot' },
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

    } else if (data === 'list_zones' || data === 'domains') {
      await handleListZones(env, chatId);

    } else if (data === 'help') {
      await handleHelp(env, chatId);

    } else if (data.startsWith('zone:')) {
      const parts = data.split(':');
      const zoneId = parts[1];
      const zoneName = parts.slice(2).join(':');
      sessions[userId] = { zoneId, zoneName };
      await handleZoneMenu(env, chatId, zoneId, zoneName);

    } else if (data === 'zone_menu') {
      await handleZoneMenu(env, chatId, session.zoneId, session.zoneName);

    } else if (data === 'records') {
      if (!session.zoneId) {
        await sendMessage(env, chatId, '❌ Session lost. Please use /start again.');
        return;
      }
      await handleListRecords(env, chatId, userId, session.zoneId, session.zoneName);

    } else if (data === 'addrec') {
      setSession(userId, { step: 'add_type' });
      await sendMessage(env, chatId,
        '➕ <b>Add DNS Record</b>\n\nSend the record <b>type</b>:\n<code>A  AAAA  CNAME  TXT  MX  NS  SRV  CAA</code>\n\n/cancel to abort',
      );

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
      const info =
        `📌 <b>Record Details</b>\n\n` +
        `Type: <b>${rec.type}</b>\n` +
        `Name: <code>${rec.name}</code>\n` +
        `Content: <code>${rec.content}</code>\n` +
        `TTL: <code>${rec.ttl === 1 ? 'Auto' : rec.ttl}</code>\n` +
        `Status: ${proxiedIcon}`;

      await sendMessage(env, chatId, info, {
        inline_keyboard: [
          [
            { text: '✏️ Edit', callback_data: 'edit_rec' },
            { text: '🗑 Delete', callback_data: `delconfirm:${shortId}` },
          ],
          [{ text: '🔙 Back to list', callback_data: 'records' }],
        ],
      });

    } else if (data === 'edit_rec') {
      setSession(userId, { step: 'edit_field' });
      await sendMessage(env, chatId,
        '✏️ <b>Edit Record</b>\n\nSend: <code>field|value</code>\n\nEditable fields:\n• <code>content|1.2.3.4</code>\n• <code>name|sub.example.com</code>\n• <code>ttl|3600</code> (or <code>1</code> for Auto)\n• <code>proxied|true</code> or <code>proxied|false</code>\n\n/cancel to abort',
      );

    } else if (data.startsWith('delconfirm:')) {
      const shortId = data.slice(11);
      const rec = session.records?.find((r) => r.id.startsWith(shortId));
      const name = rec?.name || 'this record';
      setSession(userId, { pendingDeleteId: shortId });
      await sendMessage(env, chatId,
        `⚠️ <b>Confirm Delete</b>\n\nAre you sure you want to delete:\n<code>${name}</code>`,
        {
          inline_keyboard: [
            [
              { text: '✅ Yes, delete', callback_data: `dr:${shortId}` },
              { text: '❌ Cancel', callback_data: 'records' },
            ],
          ],
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

  const text = update.message?.text?.trim();
  if (!text) return;

  // Global commands — work from anywhere
  if (text === '/start') {
    sessions[userId] = {};
    await handleStart(env, chatId);
    return;
  }
  if (text === '/help') {
    await handleHelp(env, chatId);
    return;
  }
  if (text === '/domains') {
    await handleListZones(env, chatId);
    return;
  }
  if (text === '/cancel') {
    resetStep(userId);
    if (session.zoneId) {
      await handleZoneMenu(env, chatId, session.zoneId, session.zoneName);
    } else {
      await handleStart(env, chatId);
    }
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
        `✅ <b>Record Added Successfully</b>\n\n` +
        `Type: <b>${session.recType}</b>\n` +
        `Name: <code>${session.recName}</code>\n` +
        `Content: <code>${session.recContent}</code>\n` +
        `TTL: <code>${ttl === 1 ? 'Auto' : ttl}</code>`,
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

async function handleStart(env, chatId) {
  await sendMessage(env, chatId,
    '👋 <b>Cloudflare Manager</b>\n\nManage your Cloudflare DNS records right from Telegram.\n\nWhat would you like to do?',
    {
      inline_keyboard: [
        [{ text: '🗂 My Domains', callback_data: 'list_zones' }],
        [{ text: '❓ Help', callback_data: 'help' }],
      ],
    },
  );
}

async function handleHelp(env, chatId) {
  const helpText =
    '❓ <b>Cloudflare Manager — Help</b>\n\n' +
    '<b>Commands:</b>\n' +
    '/start — Main menu\n' +
    '/domains — List all your domains\n' +
    '/help — Show this help\n' +
    '/cancel — Cancel current action\n\n' +
    '<b>How to manage DNS:</b>\n' +
    '1️⃣ Select a domain from /domains\n' +
    '2️⃣ Choose “List DNS Records”\n' +
    '3️⃣ Tap a record to view, edit, or delete\n' +
    '4️⃣ Use “Add DNS Record” to create new entries\n\n' +
    '<b>Supported record types:</b>\n' +
    '<code>A  AAAA  CNAME  TXT  MX  NS  SRV  CAA</code>\n\n' +
    '<b>Editing a record:</b>\n' +
    'Send <code>field|value</code>, e.g.:\n' +
    '• <code>content|1.2.3.4</code>\n' +
    '• <code>proxied|true</code>\n' +
    '• <code>ttl|3600</code>';

  await sendMessage(env, chatId, helpText, {
    inline_keyboard: [[{ text: '🗂 Go to Domains', callback_data: 'list_zones' }]],
  });
}

async function handleListZones(env, chatId) {
  const result = await cfRequest(env, 'GET', '/zones?per_page=50');
  if (!result.success || !result.result?.length) {
    await sendMessage(env, chatId, `❌ No domains found.\n<code>${JSON.stringify(result.errors)}</code>`);
    return;
  }
  const buttons = result.result.map((z) => [{ text: `🌐 ${z.name}`, callback_data: `zone:${z.id}:${z.name}` }]);
  buttons.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);
  await sendMessage(env, chatId, `🗂 <b>Your Domains</b> (${result.result.length})\n\nSelect a domain to manage:`, { inline_keyboard: buttons });
}

async function handleZoneMenu(env, chatId, zoneId, zoneName) {
  await sendMessage(env, chatId, `🌐 <b>${zoneName}</b>\n\nWhat would you like to do?`, {
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
    await sendMessage(env, chatId, '❌ No DNS records found for this domain.', {
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

  const text = `📋 <b>${zoneName}</b>\n${result.result.length} record(s)\n\n${lines.join('\n\n')}`;

  const buttons = result.result.map((rec, i) => [
    { text: `${i + 1}. ${rec.type} — ${rec.name}`, callback_data: `ri:${sid(rec.id)}` },
  ]);
  buttons.push([
    { text: '➕ Add Record', callback_data: 'addrec' },
    { text: '🔄 Refresh', callback_data: 'records' },
  ]);
  buttons.push([{ text: '🔙 Back', callback_data: 'zone_menu' }]);

  await sendMessage(env, chatId, text, { inline_keyboard: buttons });
}

export default {
  async fetch(request, env, ctx) {
    // Register bot commands on first load
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
