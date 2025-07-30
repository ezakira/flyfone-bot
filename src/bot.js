import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import { Bot, InlineKeyboard, session } from 'grammy';
import { Calendar } from 'grammy-calendar';
import dayjs from 'dayjs';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';
import levenshtein from 'js-levenshtein';
import * as chrono from 'chrono-node';
import {  getRefreshToken, saveRefreshToken, getFlyfoneCreds, deleteFlyfoneCreds, getSession, deleteSession, saveFlyfoneCreds, saveSession, saveSheet, getSheet, loadCookies, saveCookies, deleteRefreshToken, removeAllCookies } from './state.js';


console.log('⚙️  Env:', {
  BOT_TOKEN:    !!process.env.BOT_TOKEN,
  SUPABASE_URL: !!process.env.SUPABASE_URL,
  SUPABASE_KEY: !!process.env.SUPABASE_KEY,
  GOOGLE_CLIENT_ID:     !!process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
  BOT_REDIRECT_URI:     !!process.env.BOT_REDIRECT_URI,
});
// ── Shared in‑memory credentials store ─────────────────────────────────────────

// ── OAuth2 client setup ───────────────────────────────────────────────────────
const {
  BOT_TOKEN,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  BOT_REDIRECT_URI,
  PORT = 6565,
} = process.env;

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  BOT_REDIRECT_URI
);

const FLYFONE_BASE = 'https://my.flyfonetalk.com';


// ── Telegram bot setup ─────────────────────────────────────────────────────────
const bot = new Bot(BOT_TOKEN);
bot.use(session({ initial: () => ({ calendarOptions: {} }) }));
const calendar = new Calendar(ctx => ctx.session.calendarOptions);
bot.use(calendar);

function replyBold(ctx, text, extra = {}) {
  return ctx.reply(`<b>${text}</b>`, { parse_mode: 'HTML', ...extra });
}

// ── Google Sheets helpers ─────────────────────────────────────────────────────
async function getSheetsClientForUser(chatId) {
  try {
    const refreshToken = await getRefreshToken(chatId);
  if (refreshToken && typeof refreshToken === 'object') {
    console.error('Corrupted token format detected - deleting invalid token');
    await deleteRefreshToken(chatId);
    throw new Error('Invalid token format - please reauthenticate');
  }

    const auth = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID, 
      GOOGLE_CLIENT_SECRET, 
      BOT_REDIRECT_URI
    );
    
    auth.setCredentials({ refresh_token: refreshToken });
    
    // Return the actual sheets client
    return google.sheets({ version: 'v4', auth });
  } catch (err) {
    console.error('Error creating Sheets client:', err);
    throw new Error('Failed to create Sheets client');
  }
}

async function writeToSheet(chatId, spreadsheetId, rows, overwrite = false) {
  try {
    const sheets = await getSheetsClientForUser(chatId);
    const range = 'Sheet1!A1:Z';
    if (overwrite) {
      await sheets.spreadsheets.values.clear({ spreadsheetId, range });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'Sheet1!A1',
        valueInputOption: 'RAW',
        resource: { values: rows },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Sheet1!A1',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: rows },
      });
    }
  } catch (err) {
    console.error('Error writing to sheet:', err);
    throw err;
  }
}
// ── Flyfone scraping helpers ──────────────────────────────────────────────────

/**
 * Returns an axios client with the user's cookies loaded from Supabase.
 * @param {number} chatId
 * @returns {Promise<AxiosInstance>}
 */
export async function getFlyfoneClient(chatId) {
  console.log(`🔄 getFlyfoneClient: loading cookies for chatId=${chatId}`);
  const jar = await loadCookies(chatId);
  console.log(`✔️ loadCookies returned jar for chatId=${chatId}`, jar.constructor.name);
  return wrapper(axios.create({ jar, withCredentials: true }));
}


export async function ensureLoggedIn(chatId, email, password, client, jar) {
  console.log(`↪️ ensureLoggedIn(${chatId}, ${email}, [password redacted])`);

  // 1. If already logged in, the dashboard will return 200
  try {
    await client.get(
      `${FLYFONE_BASE}/dashboard`,
      { maxRedirects: 0, validateStatus: s => s === 200 }
    );
    console.log('✅ Already logged in');
    return;
  } catch {
    console.log('🔄 Not logged in, will fetch login page...');
  }

  // 2. Fetch login page to get CSRF token
  let loginPage;
  try {
    loginPage = await client.get(
      `${FLYFONE_BASE}/login`,
      { validateStatus: s => s === 200 }
    );
    console.log('✅ Loaded login page');
  } catch (err) {
    console.error('❌ Failed to load login page:', err);
    throw err;
  }

  const match = loginPage.data.match(/name="csrf_webcall" value="([^"]+)"/);
  if (!match) {
    const err = new Error('CSRF token not found');
    console.error('❌', err);
    throw err;
  }
  const csrf = match[1];

  // 3. POST credentials
  let resp;
  try {
    resp = await client.post(
      `${FLYFONE_BASE}/login`,
      new URLSearchParams({ csrf_webcall: csrf, username: email, password: password }),
      {
        maxRedirects: 0,
        validateStatus: s => [302, 303, 200].includes(s),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${FLYFONE_BASE}/login`,
          Origin: FLYFONE_BASE
        }
      }
    );
    console.log('➡️ Login POST status:', resp.status);
    console.log(
      '   Response snippet:',
      typeof resp.data === 'string'
        ? resp.data.slice(0, 200).replace(/\n/g, ' ')
        : '[binary]'
    );
  } catch (err) {
    console.error('❌ Login POST failed:', err);
    throw err;
  }

  // 4. Detect wrong credentials
  if (resp.status === 200 && resp.data.includes('password is incorrect')) {
    const err = new Error('Incorrect email or password');
    console.error('❌', err);
    throw err;
  }

  // 5. Persist cookies to Supabase
  try {
    await saveCookies(chatId, jar);
    console.log('✔️ saveCookies succeeded');
  } catch (err) {
    console.error('❌ saveCookies failed:', err);
    throw err;
  }
}


export async function downloadFlyfoneReport(chatId, dateStr, email, password, client, jar) {
  await ensureLoggedIn(chatId, email, password, client, jar);

  const qs = new URLSearchParams({
    from_date: dateStr,
    to_date: dateStr,
    phone: '',
    status: '0',
    autodial_id: '',
    team_id: '0'
  }).toString();

  const resp = await client.get(`${FLYFONE_BASE}/api/export/voice?${qs}`, {
    headers: { Accept: 'application/vnd.ms-excel' },
    responseType: 'arraybuffer'
  });

  if (resp.status !== 200) throw new Error(`Export failed: ${resp.status}`);

  const wb = XLSX.read(resp.data, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
}

// ── In‑memory session storage ─────────────────────────────────────────────────

function withSessionGuard(handler) {
  return async (ctx, ...args) => {
    const chatId = ctx.chat?.id || ctx.from?.id;
    const sess = await getSession(chatId);
    if (!sess) {
      await ctx.reply('<b>Session expired! Restarting...</b>', { parse_mode: 'HTML' });
      // Simulate /start command
      await deleteSession(chatId);
      const kb = new InlineKeyboard()
        .text('Yes, link a sheet', 'linkSheet:yes')
        .text('No, keep in chat', 'linkSheet:no');
      await ctx.reply('<b>Do you want to connect your Google Sheet?</b>', {
        reply_markup: kb,
        parse_mode: 'HTML',
      });
      return;
    }
    return handler(ctx, ...args);
  };
}

// Parse “YYYY-MM-DD”, “today”, “yesterday”, or free text like “July 1, 2025”
function parseDateInput(input) {
  const txt = input?.trim().toLowerCase();
  if (txt === 'today')     return new Date();
  if (txt === 'yesterday') return new Date(Date.now() - 864e5);
  // Try strict ISO
  const iso = dayjs(txt, 'YYYY-MM-DD', true);
  if (iso.isValid()) return iso.toDate();
  // Fallback to chrono‑node
  const results = chrono.parse(txt);
  return results[0]?.start?.date() ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) /start → Pick mode
// ─────────────────────────────────────────────────────────────────────────────
bot.command('start', async ctx => {
  const chatId = ctx.chat.id;
  const existingCreds = await getFlyfoneCreds(chatId);
  if (existingCreds) {
    // User already logged in - show mode selection
    const kb = new InlineKeyboard()
      .text('Yes, link a sheet', 'linkSheet:yes')
      .text('No, keep in chat', 'linkSheet:no');
      
    return ctx.reply('<b>Do you want to connect your Google Sheet?</b>', {
      parse_mode: 'HTML',
      reply_markup: kb
    });
  } else {
  await deleteSession(chatId);
  await deleteFlyfoneCreds(chatId); // fresh start

  const sess = { step: 'await_email' };
  await saveSession(chatId, sess);
  return replyBold(ctx, 'Enter your Flyfone email:');
}});

bot.callbackQuery(/^linkSheet:yes$/, async ctx => {
  const chatId = ctx.chat.id;
  await saveSession(chatId, {
    ...await getSession(chatId),
    connectSheet: true,
    mode: 'sheet',
    step: 'await_sheet_url'
  });
  await ctx.answerCallbackQuery();
  return replyBold(ctx, 'Please send your Sheet URL using:\n\n "/sheet + &lt;URL/ID&gt;"');
});

  bot.callbackQuery(/^linkSheet:no$/, async ctx => {
  const chatId = ctx.chat.id;
  // mark this chat to stay in chat mode
  await saveSession(chatId, { connectSheet: false, mode: 'chat' });
  await ctx.answerCallbackQuery();
  return replyBold(ctx, 'Chat mode enabled!\n\n Fetch /fetch to start.');
});

bot.command('mode', async ctx => {
  const chatId = ctx.chat.id;
  const creds = await getFlyfoneCreds(chatId);
  
  // Check for arguments first
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length > 0) {
    const mode = args[0].toLowerCase();
    
    if (!creds) {
      return replyBold(ctx, 'You are not logged in. Use /start to log in first.');
    }
    
    if (mode === 'chat') {
      await saveSession(chatId, {
        ...(await getSession(chatId) || {}),
        mode: 'chat',
        connectSheet: false
      });
      return replyBold(ctx, 'Chat mode enabled!');
    }
    
    if (mode === 'sheet') {
      await saveSession(chatId, {
        ...(await getSession(chatId) || {}),
        mode: 'sheet',
        connectSheet: true
      });
      return replyBold(ctx, 'Sheet mode enabled!');
    }
    
    return replyBold(ctx, 'Invalid mode. Use "/mode chat" or "/mode sheet"');
  }

  // No arguments - show mode selection
  if (!creds) {
    return replyBold(ctx, 'You are not logged in. Use /start to log in first.');
  }

  const kb = new InlineKeyboard()
    .text('Sheet mode', 'linkSheet:yes')
    .text('Chat mode', 'linkSheet:no');

  return ctx.reply('<b>Choose your mode:</b>', {
    parse_mode: 'HTML',
    reply_markup: kb
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// ❚❚ /logout: clear creds + cookies in both disk & memory
// ─────────────────────────────────────────────────────────────────────────────
bot.command('logout', async ctx => {
  const chatId = ctx.chat.id;
  
  // Clear all user data
  await Promise.all([
    deleteFlyfoneCreds(chatId),
    deleteRefreshToken(chatId),
    deleteSession(chatId),
    removeAllCookies(chatId),
    deleteSheet(chatId)
  ]);

  return ctx.reply(
    '<b>You’ve been logged out.</b>\n\n' + 
    'Your Flyfone credentials and session have been cleared.\n' +
    'Use /fetch (or /start) again to log back in.',
    { parse_mode: 'HTML' }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) /setSheet → only in Sheet-mode
// ─────────────────────────────────────────────────────────────────────────────
bot.command('sheet', async ctx => {
  const chatId = ctx.chat.id;
  const sess   = await getSession(chatId) || {};

  if (!sess.connectSheet) {
    return replyBold(ctx, 'Not in Sheet mode. Use /mode to switch.');
  }

  const input   = (ctx.message.text.split(' ')[1] || '').trim();
  const m       = input.match(/\/d\/([A-Za-z0-9_-]+)/);
  const sheetId = m
    ? m[1]
    : (/^[A-Za-z0-9-_]+$/.test(input) ? input : null);

  if (!sheetId) {
    return replyBold(
      ctx,
      '<code>/sheet URL/ID</code>\n\n' +
      'Click & copy then replace the &lt;URL/ID&gt; with yours.\n' +
      'e.g. "/sheet https://docs.google.com/spreadsheets/d/xyz..."',
      { parse_mode: 'HTML' }
    );
  }

  const creds = await getRefreshToken(chatId);
  await saveSession(chatId, { ...sess, sheetId });
  await saveSheet(chatId, sheetId);

  if (creds?.refresh_token) {
    return replyBold(ctx, 'Sheet linked! Now use /fetch to export.');
  }

  // Not authorized — prompt OAuth now
  const state = encodeURIComponent(JSON.stringify({ chatId }));

  const consentUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets'
    ],
    state,
    prompt: 'consent'
  });
  return ctx.reply('<b>Please authorize access to Google Sheets:</b>', {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: 'Authorize', url: consentUrl }]]
    }
  });
});
// ◀───────────────

// ─────────────────────────────────────────────────────────────────────────────
// 3) /fetch → dispatch to the correct flow
// ─────────────────────────────────────────────────────────────────────────────
bot.command('fetch', async ctx => {
  const chatId = ctx.chat.id;
const sess = await getSession(chatId) || {};
const creds = await getFlyfoneCreds(chatId);
    // If they already linked a sheet, default to sheet‑mode
  const linkedSheet = await getSheet(chatId);
  const mode = sess.mode || (linkedSheet ? 'sheet' : null);
  if (!creds) return replyBold(ctx, 'You are not logged in. Use /start.');
  if (!mode) return replyBold(ctx, 'No mode selected. Use /mode to pick one.');

  if (mode === 'sheet') {
    // pull the sheetId from sheetMap instead of sessionMap
    if (!linkedSheet) {
      return replyBold(ctx, 'Missing sheet. Use "/sheet + <URL/ID>".');
    }
    return beginSheetFlow(ctx);  }
  return beginChatFlow(ctx);
});


// ─────────────────────────────────────────────────────────────────────────────
// 4A) Sheet-mode flow: ask creds → calendar
// ─────────────────────────────────────────────────────────────────────────────
async function beginSheetFlow(ctx) {
  const chatId = ctx.chat.id;
  const sess   = await getSession(chatId);
  const sheetId= await getSheet(chatId);
  if (!sheetId) return replyBold(ctx, 'Send /sheet first.');

const creds = await getFlyfoneCreds(chatId);

if (!creds) return replyBold(ctx, 'You are not logged in. Use /start to log in.');

  sess.step = 'sheet_await_date';
  await saveSession(chatId, sess);
  console.log('💡 [DEBUG] beginSheetFlow skipping creds, step=sheet_await_date');
  ctx.session.calendarOptions = { defaultDate: dayjs().subtract(1, 'day').toDate() };
return ctx.reply('<b>Please choose a date:</b>', {
  reply_markup: calendar,
  parse_mode: 'HTML',
});
}

// Calendar handler for Sheet-mode
bot.filter(
  async ctx => {
    if (!ctx.calendarSelectedDate) return false;
    const session = await getSession(ctx.chat.id);
    return session?.step === 'sheet_await_date';
  },
  async ctx => {
    const chatId = ctx.chat.id;
    const sess = await getSession(chatId);
    const { email, pass } = await getFlyfoneCreds(chatId);
    console.log('💡 [DEBUG-cal] creds for', chatId, await getFlyfoneCreds(chatId));
    const dateStr = dayjs(ctx.calendarSelectedDate).format('YYYY-MM-DD');
    replyBold(ctx, `Exporting calls for ${dateStr}…`);
    return startFetchFlow(ctx, email, pass, await getSheet(chatId), dateStr);
  }
);// ─────────────────────────────────────────────────────────────────────────────
// 4B) Chat-mode flow: unchanged
// ─────────────────────────────────────────────────────────────────────────────
async function beginChatFlow(ctx) {
  const chatId = ctx.chat.id;
  const sess   = await getSession(chatId);

const creds = await getFlyfoneCreds(chatId);

sess.step = 'chat_await_date';
  await saveSession(chatId, sess);
  ctx.session.calendarOptions = { defaultDate: dayjs().subtract(1, 'day').toDate() };
return replyBold(
  ctx,
  'Select a date to view in chat:',
  { reply_markup: calendar }
);
}

bot.filter(
  async ctx => {
    if (!ctx.calendarSelectedDate) return false;
    const session = await getSession(ctx.chat.id);
    return session?.step === 'chat_await_date';
  },
  async ctx => {
    const chatId = ctx.chat.id;
    const sess   = await getSession(chatId);
    const dateStr = dayjs(ctx.calendarSelectedDate).format('YYYY-MM-DD');
    replyBold(ctx, `Fetching calls for ${dateStr}…`);
    const { email, pass } = await getFlyfoneCreds(chatId);

const jar = await loadCookies(chatId);
const client = wrapper(axios.create({ jar, withCredentials: true }));
const rows = await downloadFlyfoneReport(chatId, dateStr, email, pass, client, jar);
    // Log the parsed XLSX data to the console for debugging
    console.log('Parsed XLSX rows:', rows);

    await saveSession(chatId, { ...sess, rows, dateStr });

    const rawTeams = rows.slice(1).map(r => r[6] || '');
    const teams    = Array.from(new Set(rawTeams));
    const kb = new InlineKeyboard();
    teams.forEach(t => kb.text(t, `chat_team:${t}`).row());

    return ctx.reply('<b>Select a team:</b>', {
      parse_mode: 'HTML',
      reply_markup: kb
    });
  }
);

bot.callbackQuery(/^chat_team:(.+)$/, withSessionGuard(async ctx => {
  const chatId = ctx.chat.id;
  const { rows, dateStr } = await getSession(chatId);
  const team = ctx.match[1];

  await saveSession(chatId, { ...await getSession(chatId), selectedTeam: team });

  
  const agents = Array.from(
    new Set(rows.slice(1).filter(r => r[6] === team).map(r => r[5]))
  );
  const kb = new InlineKeyboard();
  agents.forEach(a => kb.text(a, `chat_agent:${team}|${a}`).row());
  await ctx.editMessageText(
    `<b>Team:</b> ${team}\n<b>Select an agent:</b>`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}));

bot.callbackQuery(/^chat_agent:(.+)\|(.+)$/, withSessionGuard(async ctx => {
  const chatId = ctx.chat.id;
  const [, team, agent] = ctx.match;
  const { rows, dateStr } = await getSession(chatId);

  // Use correct indexes based on your data sample
  const filtered = rows
    .slice(1)
    .filter(r => r[6] === team && r[5] === agent); // Team = r[6], Agent = r[5]
  const total = filtered.length;
  const counts = filtered.reduce((acc, r) => {
    const st = r[8]?.toString().trim(); // Status = r[8]
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {});
  await ctx.editMessageText(
    `<b>Name:</b> <b>${agent}</b>\n` +
    `<b>Date:</b> <b>${dateStr}</b>\n` +
    `<b>Calls:</b> <b>${total}</b>\n` +
    `<b>Answered:</b> <b>${counts.ANSWER || 0}</b>\n` +
    `<b>Cancelled:</b> <b>${counts.CANCEL || 0}</b>\n` +
    `<b>Busy:</b> <b>${counts.BUSY || 0}</b>`,
    { parse_mode: 'HTML' }
  );
}));

// ─────────────────────────────────────────────────────────────────────────────
// /team: Show team selection (chat mode only)
// ─────────────────────────────────────────────────────────────────────────────
bot.command('team', withSessionGuard(async ctx => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);

  // Only allow in chat mode, with rows loaded
  if (!sess || sess.mode !== 'chat' || !sess.rows) {
    return replyBold(ctx, 'This command is only available in chat mode after selecting a date.');
  }

  const rawTeams = sess.rows.slice(1).map(r => r[6] || '');
  const teams = Array.from(new Set(rawTeams));
  if (teams.length === 0) {
    return replyBold(ctx, 'No teams found for this date.');
  }
  const kb = new InlineKeyboard();
  teams.forEach(t => kb.text(t, `chat_team:${t}`).row());

  return ctx.reply('<b>Select a team:</b>', {
    parse_mode: 'HTML',
    reply_markup: kb
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// /agent: Show agent selection for current team (chat mode only)
// ─────────────────────────────────────────────────────────────────────────────
bot.command('agent', withSessionGuard(async ctx => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);

  // Parse argument
  const input = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
  if (!input) {
    // fallback to original /agent logic if no argument
    if (!sess || sess.mode !== 'chat' || !sess.rows || !sess.selectedTeam) {
      return replyBold(ctx, 'This command is only available in chat mode after selecting a team.');
    }
    const agents = Array.from(
      new Set(sess.rows.slice(1).filter(r => r[6] === sess.selectedTeam).map(r => r[5]))
    );
    if (agents.length === 0) {
      return replyBold(ctx, 'No agents found for this team.');
    }
    const kb = new InlineKeyboard();
    agents.forEach(a => kb.text(a, `chat_agent:${sess.selectedTeam}|${a}`).row());
    return ctx.reply(
      `<b>Team:</b> ${sess.selectedTeam}\n<b>Select an agent:</b>`,
      { parse_mode: 'HTML', reply_markup: kb }
    );
  }

  // Fuzzy search for agent
  if (!sess || sess.mode !== 'chat' || !sess.rows || !sess.selectedTeam) {
    return replyBold(ctx, 'This command is only available in chat mode after selecting a team.');
  }
  const agents = Array.from(
    new Set(sess.rows.slice(1).filter(r => r[6] === sess.selectedTeam).map(r => r[5]))
  );
  if (agents.length === 0) {
    return replyBold(ctx, 'No agents found for this team.');
  }

  // Find best match
  let best = null, bestScore = Infinity;
  for (const a of agents) {
    const score = levenshtein(a.toLowerCase(), input);
    if (score < bestScore) {
      bestScore = score;
      best = a;
    }
  }
  // Also allow substring match if Levenshtein is not close
  const substringMatch = agents.find(a => a.toLowerCase().includes(input));
  const agent = (substringMatch && bestScore > 2) ? substringMatch : best;

  if (!agent) {
    return replyBold(ctx, `No agent found matching "${input}".`);
  }

  // Show stats for the matched agent
  const filtered = sess.rows
    .slice(1)
    .filter(r => r[6] === sess.selectedTeam && r[5] === agent);
  const total = filtered.length;
  const counts = filtered.reduce((acc, r) => {
    const st = r[8]?.toString().trim();
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {});
  return ctx.reply(
    `<b>Name:</b> <b>${agent}</b>\n` +
    `<b>Date:</b> <b>${sess.dateStr}</b>\n` +
    `<b>Calls:</b> <b>${total}</b>\n` +
    `<b>Answered:</b> <b>${counts.ANSWER || 0}</b>\n` +
    `<b>Cancelled:</b> <b>${counts.CANCEL || 0}</b>\n` +
    `<b>Busy:</b> <b>${counts.BUSY || 0}</b>`,
    { parse_mode: 'HTML' }
  );
}));
// Update selectedTeam in chat_team callback
bot.callbackQuery(/^chat_team:(.+)$/, withSessionGuard(async ctx => {
  const chatId = ctx.chat.id;
  const { rows, dateStr } = await getSession(chatId);
  const team = ctx.match[1];
  await saveSession(chatId, { ...await getSession(chatId), selectedTeam: team }); // Save selected team

  const agents = Array.from(
    new Set(rows.slice(1).filter(r => r[6] === team).map(r => r[5]))
  );
  const kb = new InlineKeyboard();
  agents.forEach(a => kb.text(a, `chat_agent:${team}|${a}`).row());
  await ctx.editMessageText(
    `<b>Team:</b> ${team}\n<b>Select an agent:</b>`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}));

bot.command('summary',
  withSessionGuard(async ctx => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    if (parts.length < 2) {
      return ctx.reply(
        '<b>Usage:</b> <code>/summary &lt;date|today|yesterday&gt; &lt;TeamName&gt;</code>',
        { parse_mode: 'HTML' }
      );
    }

    const rawDate = parts[0];
    const team    = parts.slice(1).join(' ');
    const dateObj = parseDateInput(rawDate);
    if (!dateObj) {
      return replyBold(ctx, `Could not understand date "${rawDate}".`);
    }
    const dateStr = dayjs(dateObj).format('YYYY-MM-DD');

    const chatId = ctx.chat.id;
    const creds  = await getFlyfoneCreds(chatId);
    if (!creds) {
      return replyBold(ctx, 'You need to /fetch once (to log in) before using /summary.');
    }

    await replyBold(ctx, `Loading summary for ${team} on ${dateStr}…`);

    let rows;
    try {
      const jar = await loadCookies(chatId);
const client = wrapper(axios.create({ jar, withCredentials: true }));
      rows = await downloadFlyfoneReport(chatId, dateStr, creds.email, creds.pass, client, jar);
    } catch (err) {
      return replyBold(ctx, `Error fetching report: ${err.message}`);
    }

    const dataRows = rows.slice(1)
      .filter(r => (r[6] || '').toString() === team);
    if (dataRows.length === 0) {
      return replyBold(ctx, `No calls found for team "${team}" on ${dateStr}.`);
    }

    const counts = dataRows.reduce((acc, r) => {
      const agent = r[5] || 'Unknown';
      acc[agent] = (acc[agent] || 0) + 1;
      return acc;
    }, {});

    const header = `<b>Summary for ${team} on ${dateStr}:</b>`;
    const lines  = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([agent, c]) => `• <b>${agent}:</b> ${c}`);
    return ctx.reply([header, ...lines].join('\n'), { parse_mode: 'HTML' });
  })
);// ─────────────────────────────────────────────────────────────────────────────
// 5) Credential prompts (shared)
// ─────────────────────────────────────────────────────────────────────────────
bot.on('message:text', async ctx => {
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);
  if (!sess) return;

  if (sess.step === 'await_email') {
    sess.email = ctx.message.text.trim();
    sess.step = 'await_pass';
    await saveSession(chatId, sess);
    return replyBold(ctx, 'Enter your Flyfone password:');
  }

  if (sess.step === 'await_pass') {
    const pass = ctx.message.text.trim();
    console.log(`➡️ [await_pass] chatId=${chatId} email=${sess.email}`);
    try {
      const jar = await loadCookies(chatId);
      console.log('✔️ Loaded cookies:', jar);
    const client = wrapper(axios.create({ jar, withCredentials: true }));

     console.log('🛫 Calling ensureLoggedIn with:', { chatId, email: sess.email });
     await ensureLoggedIn(chatId, sess.email, pass, client, jar );
     console.log('✅ ensureLoggedIn succeeded');
      await saveFlyfoneCreds(chatId, sess.email, pass);

      sess.step = 'await_mode';
      await saveSession(chatId, sess);

      const kb = new InlineKeyboard()
        .text('Yes, link a sheet', 'linkSheet:yes')
        .text('No, keep in chat', 'linkSheet:no');

      return ctx.reply('<b>Login successful! Now choose a mode:</b>', {
        parse_mode: 'HTML',
        reply_markup: kb
      });
    } catch (err) {
      sess.step = 'await_email';
      await saveSession(chatId, sess);
      return replyBold(ctx, 'Credentials invalid, try your Flyfone email again:');
    }
  }
});

async function startFetchFlow(ctx, email, pass, sheetId, dateStr = null) {
  const chatId = ctx.chat.id; // Make sure this is defined
  const ds = dateStr || dayjs().subtract(1,'day').format('YYYY-MM-DD');

  try {
const jar = await loadCookies(chatId);
const client = wrapper(axios.create({ jar, withCredentials: true }));
const rows = await downloadFlyfoneReport(chatId, ds, email, pass, client, jar);
    // raw, lowercase keys
    const raw = rows.slice(1).map(r => r[6]?.toString() || '').filter(Boolean);

    // SHEET MODE
    if (sheetId) {
      const teamKeys = Array.from(new Set(raw.map(t => t.toLowerCase())));
  // merge into the existing session so we keep mode/sheet linkage
  const prev = await getSession(ctx.chat.id) || {};
  await saveSession(ctx.chat.id, { 
    ...prev,
    rows,
    dateStr: ds,
    sheetId,
  });      const kb = new InlineKeyboard();
      teamKeys.forEach(key => kb.text(key, `team:${key}`).row());
      return ctx.reply(
        `<b>Select a team to export:</b>`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
    }

    // CHAT MODE (unchanged original)
    const teams = Array.from(new Set(raw)).map(label => ({
      key:   label.toLowerCase(),
      label, 
    }));
    if (teams.length === 0) {
      return replyBold(ctx, `No teams found on ${ds}.`);
    }

  // merge into the existing session so we keep mode/sheet linkage
  const prev = await getSession(ctx.chat.id) || {};
  await saveSession(ctx.chat.id, { 
    ...prev,
    rows,
    dateStr: ds,
    sheetId,
  });   
  
  const kb = new InlineKeyboard();
    teams.forEach(t => kb.text(t.label, `team:${t.key}`).row());
    return ctx.reply('<b>Select a team:</b>', {
      parse_mode: 'HTML',
      reply_markup: kb,
    });

  } catch (err) {
    console.error('❌ startFetchFlow error:', err);
    const msg = err.message === 'Incorrect email or password'
      ? 'Incorrect email or password. Please /fetch again to retry.'
      : `Error: ${err.message}`;
    return replyBold(ctx, msg);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHEET MODE: lowercase team → write to sheet
// ─────────────────────────────────────────────────────────────────────────────
// … in your team callback, instead of immediately calling writeToSheet…
bot.callbackQuery(/^team:(.+)$/, withSessionGuard(async ctx => {
  const chatId = ctx.chat.id;
  const prev = await getSession(chatId) || {};
  if (!prev) return ctx.answerCallbackQuery({ show_alert: true, text: 'Session expired.' });

  prev.selectedTeam = ctx.match[1];
  await saveSession(chatId, prev);

  // Ask overwrite vs append:
  const kb = new InlineKeyboard()
    .text('Overwrite', `sheetMode:overwrite`)
    .text('Append',    `sheetMode:append`);
  return ctx.editMessageText(
    `<b>Do you want to overwrite existing data, or append?</b>`,
    { parse_mode: 'HTML', reply_markup: kb }
  );
}));

// Handle their choice
bot.callbackQuery(/^sheetMode:(overwrite|append)$/, withSessionGuard(async ctx => {
  const chatId = ctx.chat.id;
  const mode = ctx.match[1];                   // 'overwrite' or 'append'
  const sess = await getSession(chatId);
  const { rows, dateStr, sheetId, selectedTeam } = sess;

  // Filter & build output…
  const filtered = rows.slice(1)
    .filter(r => r[6]?.toString().toLowerCase() === selectedTeam);
  const output = [
    ['Caller','Team','Callee','Status','Duration (s)','Talktime (s)','Hangup By','Call Date','Call Time','End Time'],
    ...filtered.map(r => [r[5],r[6],r[7],r[8],r[9],r[10],r[11],r[1],r[2],r[3]])
  ];

  try {
    await writeToSheet(
      ctx.chat.id,
      sheetId,
      output,
      mode === 'overwrite'
    );
    await ctx.editMessageText(
      `<b>${mode === 'overwrite' ? 'Overwrote' : 'Appended'} ${filtered.length} rows for team “${selectedTeam}” on ${dateStr}</b>`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error(err);
    await ctx.editMessageText(`❌ Write failed: ${err.message}`);
  }
}));

const app = express();
app.use(bodyParser.urlencoded({ extended:false }));

app.get('/oauth2callback', async (req, res) => {
  console.log('🔔 /oauth2callback hit with state:', req.query.state);
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state.');

  let chatId;
  try {
    ({ chatId } = JSON.parse(decodeURIComponent(state)));
  } catch {
    return res.status(400).send('Invalid state.');
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    // FIX: Only save if we actually got a refresh token
    if (tokens.refresh_token) {
      // Store JUST the refresh token string, not the whole tokens object
      await saveRefreshToken(chatId, tokens.refresh_token);
      console.log('✔️ Saved refresh token for', chatId);
    } else {
      console.warn('⚠️ No refresh_token received - user must re-consent');
    }

    await bot.api.sendMessage(
      chatId,
      '<b>Authorized! Do /fetch now.</b>',
      { parse_mode: 'HTML' }
    );
    res.send('Authorization successful! You can close this tab.');
  } catch (err) {
    console.error('🔥 OAuth callback error:', err);
    return res.status(500).send(`Auth error: ${err.message}`);
  }
});// ─────────────────────────────────────────────────────────────────────────────
// Gracefully save state before shutdown
// ─────────────────────────────────────────────────────────────────────────────
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());


app.listen(PORT, () => {
  console.log(`OAuth2 callback listening on http://localhost:${PORT}`);
});


bot.start({
  onStart: info => console.log(`Polling as @${info.username}`)
});
bot.catch(err => {
  console.error('Unhandled bot error:', err.error);
});
