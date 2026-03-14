const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// ─── Cloudflare API helpers ───────────────────────────────────────────────────

async function cfRequest(env, method, path, body) {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function listZones(env) {
  const data = await cfRequest(env, 'GET', '/zones?per_page=50');
  return data.result || [];
}

async function listRecords(env, zoneId) {
  const data = await cfRequest(env, 'GET', `/zones/${zoneId}/dns_records?per_page=100`);
  return data.result || [];
}

async function addRecord(env, zoneId, type, name, content, ttl, proxied) {
  return cfRequest(env, 'POST', `/zones/${zoneId}/dns_records`, {
    type,
    name,
    content,
    ttl: ttl || 1,
    proxied: proxied || false,
  });
}

async function deleteRecord(env, zoneId, recordId) {
  return cfRequest(env, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
}

async function updateRecord(env, zoneId, recordId, type, name, content, ttl, proxied) {
  return cfRequest(env, 'PATCH', `/zones/${zoneId}/dns_records/${recordId}`, {
    type,
    name,
    content,
    ttl: ttl || 1,
    proxied: proxied || false,
  });
}

// ─── Telegram API helpers ─────────────────────────────────────────────────────

async function tgRequest(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(env, chatId, text, extra) {
  return tgRequest(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

async function editMessage(env, chatId, messageId, text, extra) {
  return tgRequest(env.TELEGRAM_BOT_TOKEN, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...extra,
  });
}

async function answerCallback(env, callbackQueryId, text) {
  return tgRequest(env.TELEGRAM_BOT_TOKEN, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || '',
  });
}

// ─── Keyboard builders ────────────────────────────────────────────────────────

function zonesKeyboard(zones) {
  const buttons = zones.map(z => [{ text: z.name, callback_data: `zone:${z.id}:${z.name}` }]);
  buttons.push([{ text: '🔄 Refresh', callback_data: 'zones' }]);
  return { inline_keyboard: buttons };
}

function zoneActionsKeyboard(zoneId, zoneName) {
  return {
    inline_keyboard: [
      [{ text: '📋 List Records', callback_data: `list:${zoneId}:${zoneName}:1` }],
      [{ text: '➕ Add Record', callback_data: `add_start:${zoneId}:${zoneName}` }],
      [{ text: '◀️ Back to Zones', callback_data: 'zones' }],
    ],
  };
}

function recordsKeyboard(records, zoneId, zoneName, page) {
  const PAGE_SIZE = 8;
  const start = (page - 1) * PAGE_SIZE;
  const slice = records.slice(start, start + PAGE_SIZE);
  const buttons = slice.map(r => [
    {
      text: `${r.type} | ${r.name} → ${r.content}`,
      callback_data: `record:${zoneId}:${zoneName}:${r.id}`,
    },
  ]);
  const nav = [];
  if (page > 1) nav.push({ text: '⬅️ Prev', callback_data: `list:${zoneId}:${zoneName}:${page - 1}` });
  if (start + PAGE_SIZE < records.length) nav.push({ text: 'Next ➡️', callback_data: `list:${zoneId}:${zoneName}:${page + 1}` });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: '➕ Add Record', callback_data: `add_start:${zoneId}:${zoneName}` }]);
  buttons.push([{ text: '◀️ Back', callback_data: `zone:${zoneId}:${zoneName}` }]);
  return { inline_keyboard: buttons };
}

function recordActionsKeyboard(zoneId, zoneName, recordId) {
  return {
    inline_keyboard: [
      [{ text: '✏️ Edit', callback_data: `edit_start:${zoneId}:${zoneName}:${recordId}` }],
      [{ text: '🗑️ Delete', callback_data: `del_confirm:${zoneId}:${zoneName}:${recordId}` }],
      [{ text: '◀️ Back', callback_data: `list:${zoneId}:${zoneName}:1` }],
    ],
  };
}

function confirmDeleteKeyboard(zoneId, zoneName, recordId) {
  return {
    inline_keyboard: [
      [{ text: '✅ Yes, Delete', callback_data: `del_do:${zoneId}:${zoneName}:${recordId}` }],
      [{ text: '❌ Cancel', callback_data: `record:${zoneId}:${zoneName}:${recordId}` }],
    ],
  };
}

// ─── Session store (in-memory, per isolate) ───────────────────────────────────
// Stores pending multi-step input state keyed by chatId
const sessions = new Map();

// ─── Update handler ───────────────────────────────────────────────────────────

async function handleUpdate(env, update) {
  const chatId =
    update.message?.chat?.id ||
    update.callback_query?.message?.chat?.id;

  // Auth check
  if (String(chatId) !== String(env.ALLOWED_USER_ID)) {
    if (update.message) {
      await sendMessage(env, chatId, '⛔ Unauthorized.');
    }
    return;
  }

  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }

  if (update.message) {
    await handleMessage(env, update.message);
  }
}

// ─── Callback query handler ───────────────────────────────────────────────────

async function handleCallback(env, cq) {
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const data = cq.data;
  await answerCallback(env, cq.id);

  if (data === 'zones') {
    const zones = await listZones(env);
    if (!zones.length) {
      await editMessage(env, chatId, msgId, 'No zones found.');
      return;
    }
    await editMessage(env, chatId, msgId, '🌐 <b>Select a zone:</b>', { reply_markup: zonesKeyboard(zones) });
    return;
  }

  const parts = data.split(':');
  const action = parts[0];

  if (action === 'zone') {
    const [, zoneId, zoneName] = parts;
    await editMessage(env, chatId, msgId, `📁 <b>${zoneName}</b>\nChoose an action:`, {
      reply_markup: zoneActionsKeyboard(zoneId, zoneName),
    });
    return;
  }

  if (action === 'list') {
    const [, zoneId, zoneName, pageStr] = parts;
    const page = parseInt(pageStr) || 1;
    const records = await listRecords(env, zoneId);
    if (!records.length) {
      await editMessage(env, chatId, msgId, `No DNS records found for <b>${zoneName}</b>.`, {
        reply_markup: zoneActionsKeyboard(zoneId, zoneName),
      });
      return;
    }
    await editMessage(
      env,
      chatId,
      msgId,
      `📋 <b>${zoneName}</b> — ${records.length} record(s)\nPage ${page}:`,
      { reply_markup: recordsKeyboard(records, zoneId, zoneName, page) },
    );
    return;
  }

  if (action === 'record') {
    const [, zoneId, zoneName, recordId] = parts;
    const records = await listRecords(env, zoneId);
    const r = records.find(x => x.id === recordId);
    if (!r) {
      await editMessage(env, chatId, msgId, 'Record not found.');
      return;
    }
    const info =
      `<b>Type:</b> ${r.type}\n` +
      `<b>Name:</b> ${r.name}\n` +
      `<b>Content:</b> ${r.content}\n` +
      `<b>TTL:</b> ${r.ttl}\n` +
      `<b>Proxied:</b> ${r.proxied}`;
    await editMessage(env, chatId, msgId, info, {
      reply_markup: recordActionsKeyboard(zoneId, zoneName, recordId),
    });
    return;
  }

  if (action === 'del_confirm') {
    const [, zoneId, zoneName, recordId] = parts;
    await editMessage(env, chatId, msgId, '⚠️ Are you sure you want to delete this record?', {
      reply_markup: confirmDeleteKeyboard(zoneId, zoneName, recordId),
    });
    return;
  }

  if (action === 'del_do') {
    const [, zoneId, , recordId] = parts;
    const res = await deleteRecord(env, zoneId, recordId);
    if (res.success) {
      await editMessage(env, chatId, msgId, '✅ Record deleted successfully.', {
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Zone', callback_data: `zone:${parts[1]}:${parts[2]}` }]] },
      });
    } else {
      await editMessage(env, chatId, msgId, `❌ Error: ${JSON.stringify(res.errors)}`);
    }
    return;
  }

  if (action === 'add_start') {
    const [, zoneId, zoneName] = parts;
    sessions.set(chatId, { step: 'add_type', zoneId, zoneName });
    await sendMessage(
      env,
      chatId,
      `➕ <b>Add DNS Record for ${zoneName}</b>\n\nEnter record type (A, AAAA, CNAME, TXT, MX, etc.):`,
    );
    return;
  }

  if (action === 'edit_start') {
    const [, zoneId, zoneName, recordId] = parts;
    const records = await listRecords(env, zoneId);
    const r = records.find(x => x.id === recordId);
    if (!r) return;
    sessions.set(chatId, { step: 'edit_type', zoneId, zoneName, recordId, old: r });
    await sendMessage(
      env,
      chatId,
      `✏️ <b>Edit Record</b>\nCurrent: <code>${r.type} ${r.name} → ${r.content}</code>\n\nEnter new type (or send <code>.</code> to keep <b>${r.type}</b>):`,
    );
    return;
  }
}

// ─── Message handler (multi-step input) ───────────────────────────────────────

async function handleMessage(env, message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  if (text === '/start' || text === '/menu') {
    sessions.delete(chatId);
    const zones = await listZones(env);
    if (!zones.length) {
      await sendMessage(env, chatId, 'No zones found in your Cloudflare account.');
      return;
    }
    await sendMessage(env, chatId, '🌐 <b>Cloudflare DNS Manager</b>\nSelect a zone:', {
      reply_markup: zonesKeyboard(zones),
    });
    return;
  }

  if (text === '/cancel') {
    sessions.delete(chatId);
    await sendMessage(env, chatId, '❌ Cancelled. Send /menu to start.');
    return;
  }

  const session = sessions.get(chatId);
  if (!session) {
    await sendMessage(env, chatId, 'Send /menu to start.');
    return;
  }

  // ── ADD flow ──
  if (session.step === 'add_type') {
    session.type = text.toUpperCase();
    session.step = 'add_name';
    await sendMessage(env, chatId, `Enter record name (e.g. <code>sub.example.com</code> or <code>@</code>):`);
    return;
  }

  if (session.step === 'add_name') {
    session.name = text;
    session.step = 'add_content';
    await sendMessage(env, chatId, `Enter record content (IP, hostname, or value):`);
    return;
  }

  if (session.step === 'add_content') {
    session.content = text;
    session.step = 'add_proxied';
    await sendMessage(env, chatId, `Proxied through Cloudflare? Reply <code>yes</code> or <code>no</code>:`);
    return;
  }

  if (session.step === 'add_proxied') {
    const proxied = text.toLowerCase() === 'yes';
    const res = await addRecord(env, session.zoneId, session.type, session.name, session.content, 1, proxied);
    sessions.delete(chatId);
    if (res.success) {
      await sendMessage(
        env,
        chatId,
        `✅ Record added!\n<code>${session.type} ${session.name} → ${session.content}</code>`,
        { reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Zone', callback_data: `zone:${session.zoneId}:${session.zoneName}` }]] } },
      );
    } else {
      await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(res.errors)}`);
    }
    return;
  }

  // ── EDIT flow ──
  if (session.step === 'edit_type') {
    session.newType = text === '.' ? session.old.type : text.toUpperCase();
    session.step = 'edit_name';
    await sendMessage(env, chatId, `Enter new name (or <code>.</code> to keep <b>${session.old.name}</b>):`);
    return;
  }

  if (session.step === 'edit_name') {
    session.newName = text === '.' ? session.old.name : text;
    session.step = 'edit_content';
    await sendMessage(env, chatId, `Enter new content (or <code>.</code> to keep <b>${session.old.content}</b>):`);
    return;
  }

  if (session.step === 'edit_content') {
    session.newContent = text === '.' ? session.old.content : text;
    session.step = 'edit_proxied';
    await sendMessage(
      env,
      chatId,
      `Proxied? Reply <code>yes</code> or <code>no</code> (current: <b>${session.old.proxied}</b>):`,
    );
    return;
  }

  if (session.step === 'edit_proxied') {
    const proxied = text.toLowerCase() === 'yes';
    const res = await updateRecord(
      env,
      session.zoneId,
      session.recordId,
      session.newType,
      session.newName,
      session.newContent,
      1,
      proxied,
    );
    sessions.delete(chatId);
    if (res.success) {
      await sendMessage(
        env,
        chatId,
        `✅ Record updated!\n<code>${session.newType} ${session.newName} → ${session.newContent}</code>`,
        { reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Zone', callback_data: `zone:${session.zoneId}:${session.zoneName}` }]] } },
      );
    } else {
      await sendMessage(env, chatId, `❌ Error: ${JSON.stringify(res.errors)}`);
    }
    return;
  }
}

// ─── Worker entry point ───────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }
    try {
      const update = await request.json();
      await handleUpdate(env, update);
    } catch (e) {
      console.error(e);
    }
    return new Response('OK', { status: 200 });
  },
};
