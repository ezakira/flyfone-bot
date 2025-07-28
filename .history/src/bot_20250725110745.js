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
    return replyBold(ctx, 'Great! Now send "/setSheet URL or ID".');
  } else {
    return replyBold(ctx, 'Okay, the results will stay in chat. Do /fetch to start.');
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
    'Your Flyfone credentials and session cookies have been cleared.\n' +
    'Use /fetch (or /start) again to log back in.',
    { parse_mode: 'HTML' }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) /setSheet → only in Sheet-mode
// ─────────────────────────────────────────────────────────────────────────────
bot.command('setSheet', async ctx => {
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
  if (!sheetId) return replyBold(ctx, 'Invalid URL or ID.');

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
  if (!sheetId) return replyBold(ctx, 'Send /setSheet first.');

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
    console.log('Fetched XLSX rows:', JSON.stringify(rows, null, 2));

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

bot.callbackQuery(/^chat_team:(.+)$/, async ctx => {
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
});

bot.callbackQuery(/^chat_agent:(.+)\|(.+)$/, async ctx => {
  const chatId = ctx.chat.id;
  const [, team, agent] = ctx.match;
  const { rows, dateStr } = sessionMap.get(chatId);
  const filtered = rows
    .slice(1)
    .filter(r => r[1] === team && r[0] === agent); // Team = r[1], Agent = r[0]
  const total = filtered.length;
  const counts = filtered.reduce((acc, r) => {
    const st = r[3]?.toString().trim(); // Status = r[3]
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {});
  await ctx.editMessageText(
    `<b>Name:</b> <b>${agent}</b>\n` +
    `<b>Date:</b> <b>${dateStr}</b>\n` +
    `<b>Calls:</b> <b>${total}</b>\n` +
    `<b>Answered:</b> <b>${counts.ANSWER || 0}</b>\n` + // Use "ANSWER" as in your sheet
    `<b>Cancelled:</b> <b>${counts.CANCEL || 0}</b>\n` +
    `<b>Busy:</b> <b>${counts.BUSY || 0}</b>`,
    { parse_mode: 'HTML' }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// /team: Show team selection (chat mode only)
// ─────────────────────────────────────────────────────────────────────────────
bot.command('team', async ctx => {
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
});

// ─────────────────────────────────────────────────────────────────────────────
// /agent: Show agent selection for current team (chat mode only)
// ─────────────────────────────────────────────────────────────────────────────
bot.command('agent', async ctx => {
  const chatId = ctx.chat.id;
  const sess = sessionMap.get(chatId);

  // Only allow in chat mode, with rows and a selected team
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
});

// Update selectedTeam in chat_team callback
bot.callbackQuery(/^chat_team:(.+)$/, async ctx => {
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
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Credential prompts (shared)
// ─────────────────────────────────────────────────────────────────────────────
bot.on('message:text', async ctx => {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);
  if (!sess) return;

  if (['sheet_await_email','chat_await_email'].includes(sess.step)) {
    sess.email = ctx.message.text.trim();
    sess.step  = sess.step.startsWith('sheet_') ? 'sheet_await_pass' : 'chat_await_pass';
    return replyBold(ctx, 'Now enter your Flyfone password:');
  }

  if (['sheet_await_pass','chat_await_pass'].includes(sess.step)) {
    const pass = ctx.message.text.trim();
    try {
      await ensureLoggedIn(sess.email, pass);
      userCreds.set(chatId, { email: sess.email, pass });
      sess.step = sess.step.startsWith('sheet_') ? 'sheet_await_date' : 'chat_await_date';
      sessionMap.set(chatId, sess);
      ctx.session.calendarOptions = { defaultDate: dayjs().subtract(1,'day').toDate() };
return ctx.reply('<b>Please choose a date:</b>', {
  reply_markup: calendar,
  parse_mode: 'HTML'
});
    } catch (err) {
      sess.step = sess.step.startsWith('sheet_') ? 'sheet_await_email' : 'chat_await_email';
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
bot.callbackQuery(/^team:(.+)$/, async ctx => {
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
});

// Handle their choice
bot.callbackQuery(/^sheetMode:(overwrite|append)$/, async ctx => {
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
});

bot.start({
  onStart: info => console.log(`Polling as @${info.username}`)
});
bot.catch(err => {
  console.error('Unhandled bot error:', err.error);
});
