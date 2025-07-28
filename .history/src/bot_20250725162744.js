import 'dotenv/config';
import { Bot, InlineKeyboard, session } from 'grammy';
import { Calendar } from 'grammy-calendar';
import dayjs from 'dayjs';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeToSheet } from './gsheets.js';
import levenshtein from 'js-levenshtein'; 
import * as chrono from 'chrono-node';


// Resolve __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Path to persist cookies
const COOKIE_FILE = path.resolve(__dirname, '../cookies.json');

function loadCookieJar() {
  let jar = new CookieJar();
  if (fs.existsSync(COOKIE_FILE)) {
    try {
      const json = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      jar = CookieJar.fromJSON(json);
    } catch (e) {
      console.warn('Failed to load cookie jar, starting fresh:', e.message);
    }
  }
  return jar;
}

function saveCookieJar(jar) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(jar.toJSON(), null, 2));
}

const FLYFONE_BASE = 'https://my.flyfonetalk.com';
const jar           = loadCookieJar();
const client        = wrapper(axios.create({ jar, withCredentials: true }));

// Ensure we have a valid Flyfone session
async function ensureLoggedIn(email, password) {
  try {
    await client.get(`${FLYFONE_BASE}/dashboard`, {
      maxRedirects: 0,
      validateStatus: s => s === 200,
    });
    return;
  } catch {
    // not logged in, proceed to login
  }

  console.log('Logging in to Flyfone…');
  const loginPage = await client.get(`${FLYFONE_BASE}/login`, {
    validateStatus: s => s === 200,
  });
  const match = loginPage.data.match(/name="csrf_webcall" value="([^"]+)"/);
  if (!match) throw new Error('CSRF token not found');
  const csrf = match[1];

  try {
    const resp = await client.post(
      `${FLYFONE_BASE}/login`,
      new URLSearchParams({ csrf_webcall: csrf, username: email, password }),
      {
        maxRedirects: 0,
        validateStatus: s => [302, 303, 200].includes(s),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${FLYFONE_BASE}/login`,
          Origin: FLYFONE_BASE,
        },
      }
    );

    if (resp.status === 200 && resp.data.includes('Account or password is incorrect')) {
      throw new Error('Incorrect email or password');
    }

    saveCookieJar(jar);
    console.log('Login successful, cookies saved.');
  } catch (err) {
    if (err.message === 'Incorrect email or password') throw err;
    throw new Error(`Login failed: ${err.message}`);
  }
}

// Download and parse the XLSX report for a given date
async function downloadFlyfoneReport(dateStr, email, password) {
  await ensureLoggedIn(email, password);

  const qs = new URLSearchParams({
    from_date: dateStr,
    to_date:   dateStr,
    phone:     '',
    status:    '0',
    autodial_id: '',
    team_id:     '0',
  }).toString();

  const resp = await client.get(`${FLYFONE_BASE}/api/export/voice?${qs}`, {
    headers:      { Accept: 'application/vnd.ms-excel' },
    responseType: 'arraybuffer',
  });
  if (resp.status !== 200) {
    throw new Error(`Export failed: HTTP ${resp.status}`);
  }

  const wb = XLSX.read(resp.data, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot setup
// ─────────────────────────────────────────────────────────────────────────────
const sheetMap   = new Map();
const sessionMap = new Map();
const userCreds  = new Map();

const bot = new Bot(process.env.BOT_TOKEN);
bot.use(session({ initial: () => ({ calendarOptions: {} }) }));
const calendar = new Calendar(ctx => ctx.session.calendarOptions);
bot.use(calendar);

function replyBold(ctx, text, extra = {}) {
  return ctx.reply(`<b>${text}</b>`, { parse_mode: 'HTML', ...extra });
}

function withSessionGuard(handler) {
  return async (ctx, ...args) => {
    const chatId = ctx.chat?.id || ctx.from?.id;
    const sess = sessionMap.get(chatId);
    if (!sess) {
      await ctx.reply('<b>Session expired! Restarting...</b>', { parse_mode: 'HTML' });
      // Simulate /start command
      sessionMap.delete(chatId);
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
  sessionMap.delete(ctx.chat.id);
  const kb = new InlineKeyboard()
    .text('Yes, link a sheet', 'linkSheet:yes')
    .text('No, keep in chat', 'linkSheet:no');
  await ctx.reply('<b>Do you want to connect your Google Sheet?</b>', {
    reply_markup: kb,
    parse_mode: 'HTML',
  });
});

bot.callbackQuery(/^linkSheet:(yes|no)$/, async ctx => {
  const chatId = ctx.chat.id;
  const mode = ctx.match[1] === 'yes' ? 'sheet' : 'chat';
  const sess = { connectSheet: mode === 'sheet', mode };
  sessionMap.set(chatId, sess);
  await ctx.answerCallbackQuery();
  if (sess.connectSheet) {
    return replyBold(ctx, 'Great! Now send "/sheet URL or ID".');
  } else {
    sess.step = 'chat_await_email';
    sessionMap.set(chatId, sess);
    return replyBold(ctx, 'Chat mode enabled!\n\nEnter your Flyfone email:');
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ❚❚ /logout: clear creds + cookies in both disk & memory
// ─────────────────────────────────────────────────────────────────────────────
bot.command('logout', async ctx => {
  const chatId = ctx.chat.id;

  // 1) clear our maps
  userCreds.delete(chatId);
  sessionMap.delete(chatId);

  // 2) delete the on‑disk cookie file
  if (fs.existsSync(COOKIE_FILE)) {
    fs.unlinkSync(COOKIE_FILE);
  }

  // 3) wipe the live CookieJar in RAM
  await jar.removeAllCookies();

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
  const sess   = sessionMap.get(chatId) || {};
  if (!sess.connectSheet) {
    return replyBold(ctx, 'You didn’t opt to link a sheet. Use /start to change.');
  }
  const input = (ctx.message.text.split(' ')[1] || '').trim();
  const m     = input.match(/\/d\/([A-Za-z0-9_-]+)/);
  const sheetId = m
    ? m[1]
    : (/^[A-Za-z0-9-_]+$/.test(input) ? input : null);
  if (!sheetId) return replyBold(ctx, '<code>/sheet URL/ID</code>\n\nClick & copy then replace the &lt;URL/ID&gt; with yours.\ne.g. "/sheet https://docs.google.com/spreadsheets/d/xyz..." ', { parse_mode: 'HTML' });

  sheetMap.set(chatId, sheetId);
  await replyBold(ctx, `Sheet linked: ${sheetId}`);
  return beginSheetFlow(ctx);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) /fetch → dispatch to the correct flow
// ─────────────────────────────────────────────────────────────────────────────
bot.command('fetch', async ctx => {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);
  if (sess?.connectSheet === undefined) {
    return replyBold(ctx, 'Please run /start first and choose a mode.');
  }
  if (sess.connectSheet) {
    return beginSheetFlow(ctx);
  } else {
    return beginChatFlow(ctx);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4A) Sheet-mode flow: ask creds → calendar
// ─────────────────────────────────────────────────────────────────────────────
async function beginSheetFlow(ctx) {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);
  const sheetId= sheetMap.get(chatId);
  if (!sheetId) return replyBold(ctx, 'Send /sheet first.');

  const creds = userCreds.get(chatId);
  if (!creds) {
    sess.step = 'sheet_await_email';
    return replyBold(ctx, 'Enter your Flyfone email:');
  }

  sess.step = 'sheet_await_date';
  sessionMap.set(chatId, sess);
  ctx.session.calendarOptions = { defaultDate: dayjs().subtract(1, 'day').toDate() };
return ctx.reply('<b>Please choose a date:</b>', {
  reply_markup: calendar,
  parse_mode: 'HTML',
});
}

// Calendar handler for Sheet-mode
bot.filter(
  ctx =>
    ctx.calendarSelectedDate &&
    sessionMap.get(ctx.chat.id)?.step === 'sheet_await_date',
  async ctx => {
    const chatId = ctx.chat.id;
    const sess   = sessionMap.get(chatId);
    const { email, pass } = userCreds.get(chatId);
    const dateStr = dayjs(ctx.calendarSelectedDate).format('YYYY-MM-DD');
    replyBold(ctx, `Exporting calls for ${dateStr}…`);
    return startFetchFlow(ctx, email, pass, sheetMap.get(chatId), dateStr);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 4B) Chat-mode flow: unchanged
// ─────────────────────────────────────────────────────────────────────────────
async function beginChatFlow(ctx) {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);

  const creds = userCreds.get(chatId);
  if (!creds) {
    sess.step = 'chat_await_email';
    sessionMap.set(chatId, sess);
    return replyBold(ctx, 'Enter your Flyfone email:');
  }

  sess.step = 'chat_await_date';
  sessionMap.set(chatId, sess);
  ctx.session.calendarOptions = { defaultDate: dayjs().subtract(1, 'day').toDate() };
  return ctx.reply('<b>Select a date to view in chat:</b>', { reply_markup: calendar });
}

bot.filter(
  ctx =>
    ctx.calendarSelectedDate &&
    sessionMap.get(ctx.chat.id)?.step === 'chat_await_date',
  async ctx => {
    const chatId = ctx.chat.id;
    const sess   = sessionMap.get(chatId);
    const dateStr = dayjs(ctx.calendarSelectedDate).format('YYYY-MM-DD');
    replyBold(ctx, `Fetching calls for ${dateStr}…`);
    const { email, pass } = userCreds.get(chatId);

    const rows = await downloadFlyfoneReport(dateStr, email, pass);

    // Log the parsed XLSX data to the console for debugging

    sessionMap.set(chatId, { ...sess, rows, dateStr });

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
  const { rows, dateStr } = sessionMap.get(chatId);
  const team = ctx.match[1];

  sessionMap.set(chatId, { ...sessionMap.get(chatId), selectedTeam: team });

  
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
  const { rows, dateStr } = sessionMap.get(chatId);

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
  const sess = sessionMap.get(chatId);

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
  const sess = sessionMap.get(chatId);

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
  const { rows, dateStr } = sessionMap.get(chatId);
  const team = ctx.match[1];
  sessionMap.set(chatId, { ...sessionMap.get(chatId), selectedTeam: team }); // Save selected team

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
    const creds  = userCreds.get(chatId);
    if (!creds) {
      return replyBold(ctx, 'You need to /fetch once (to log in) before using /summary.');
    }

    await replyBold(ctx, `Loading summary for ${team} on ${dateStr}…`);

    let rows;
    try {
      rows = await downloadFlyfoneReport(dateStr, creds.email, creds.pass);
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
  const sess   = sessionMap.get(chatId);
  if (!sess) return;

if (['sheet_await_pass','chat_await_pass'].includes(sess.step)) {
  const pass = ctx.message.text.trim();
  try {
    await ensureLoggedIn(sess.email, pass);
    userCreds.set(chatId, { email: sess.email, pass });

    if (sess.step === 'sheet_await_pass') {
      // Sheet‑mode: still want to go straight to calendar
      sess.step = 'sheet_await_date';
      sessionMap.set(chatId, sess);
      ctx.session.calendarOptions = { defaultDate: dayjs().subtract(1,'day').toDate() };
      return ctx.reply(
        '<b>Please choose a date to export:</b>',
        { reply_markup: calendar, parse_mode: 'HTML' }
      );
    } else {
      // Chat‑mode: STOP here and ask them to /fetch
      sess.step = 'ready';                // or clear step entirely
      sessionMap.set(chatId, sess);
      return replyBold(
        ctx,
        'Okay, the results will stay in chat. Do /fetch to start.'
      );
    }
  } catch (err) {
    // on failure, reset to ask for email again
    sess.step = sess.step.startsWith('sheet_')
               ? 'sheet_await_email'
               : 'chat_await_email';
    sessionMap.set(chatId, sess);
    return replyBold(ctx, 'Credentials invalid, try your email again.');
  }
}
});

async function startFetchFlow(ctx, email, pass, sheetId, dateStr = null) {
  const ds = dateStr || dayjs().subtract(1,'day').format('YYYY-MM-DD');

  try {
    const rows = await downloadFlyfoneReport(ds, email, pass);

    // raw, lowercase keys
    const raw = rows.slice(1).map(r => r[6]?.toString() || '').filter(Boolean);

    // SHEET MODE
    if (sheetId) {
      const teamKeys = Array.from(new Set(raw.map(t => t.toLowerCase())));
      sessionMap.set(ctx.chat.id, { rows, dateStr: ds, sheetId });
      const kb = new InlineKeyboard();
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

    sessionMap.set(ctx.chat.id, { rows, dateStr: ds, sheetId: null });
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
  const sess = sessionMap.get(chatId);
  if (!sess) return ctx.answerCallbackQuery({ show_alert: true, text: 'Session expired.' });

  sess.selectedTeam = ctx.match[1];
  sessionMap.set(chatId, sess);

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
  const sess = sessionMap.get(chatId);
  const { rows, dateStr, sheetId, selectedTeam } = sess;

  // Filter & build output…
  const filtered = rows.slice(1)
    .filter(r => r[6]?.toString().toLowerCase() === selectedTeam);
  const output = [
    ['Caller','Team','Callee','Status','Duration (s)','Talktime (s)','Hangup By','Call Date','Call Time','End Time'],
    ...filtered.map(r => [r[5],r[6],r[7],r[8],r[9],r[10],r[11],r[1],r[2],r[3]])
  ];

  try {
    await writeToSheet(sheetId, output, mode === 'overwrite');
    await ctx.editMessageText(
      `<b>${mode === 'overwrite' ? 'Overwrote' : 'Appended'} ${filtered.length} rows for team “${selectedTeam}” on ${dateStr}</b>`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error(err);
    await ctx.editMessageText(`❌ Write failed: ${err.message}`);
  }
}));

bot.start({
  onStart: info => console.log(`Polling as @${info.username}`)
});
bot.catch(err => {
  console.error('Unhandled bot error:', err.error);
});
