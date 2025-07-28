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
const __dirname = path.dirname(__filename);

// Path to persist cookies (will live in ./cookies.json)
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
const jar = loadCookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

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

    // If status is 200, login failed—check for error message in HTML
    if (resp.status === 200 && resp.data.includes('Account or password is incorrect')) {
      throw new Error('Incorrect email or password');
    }

    // Otherwise should have redirected on success
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
    to_date: dateStr,
    phone: '',
    status: '0',
    autodial_id: '',
    team_id: '0',
  }).toString();

  const resp = await client.get(`${FLYFONE_BASE}/api/export/voice?${qs}`, {
    headers: { Accept: 'application/vnd.ms-excel' },
    responseType: 'arraybuffer',
  });
  if (resp.status !== 200) {
    throw new Error(`Export failed: HTTP ${resp.status}`);
  }

  const wb = XLSX.read(resp.data, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
}
// Bot setup
// ─────────────────────────────────────────────────────────────────────────────
const sheetMap   = new Map();
const sessionMap = new Map();
const userCreds  = new Map();

const bot = new Bot(process.env.BOT_TOKEN);
bot.use(session({ initial: () => ({ calendarOptions: {} }) }));
const calendar = new Calendar(ctx => ctx.session.calendarOptions);
bot.use(calendar);

function replyBold(ctx, text, extra={}) {
  return ctx.reply(`<b>${text}</b>`, { parse_mode:'HTML', ...extra });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) /start → Pick mode
// ─────────────────────────────────────────────────────────────────────────────
bot.command('start', async ctx => {
  sessionMap.delete(ctx.chat.id);  // clear any previous state
  const kb = new InlineKeyboard()
    .text('Yes, link a sheet', 'linkSheet:yes')
    .text('No, keep in chat', 'linkSheet:no');
  await ctx.reply('Do you want to connect your Google Sheet?', { reply_markup: kb });
});

bot.callbackQuery(/^linkSheet:(yes|no)$/, async ctx => {
  const chatId = ctx.chat.id;
  const sess   = { connectSheet: ctx.match[1]==='yes' };
  sessionMap.set(chatId, sess);

  await ctx.answerCallbackQuery();
  if (sess.connectSheet) {
    return replyBold(ctx, 'Great! Now send "/setSheet URL or ID".');
  } else {
    return replyBold(ctx, 'Okay, the results will stay in chat.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) /setSheet → only in Sheet‑mode
// ─────────────────────────────────────────────────────────────────────────────
bot.command('setSheet', async ctx => {
  const chatId = ctx.chat.id;
  const sess = sessionMap.get(chatId) || {};
  if (!sess.connectSheet) {
    return replyBold(ctx, 'You didn’t opt to link a sheet. Use /start to change.');
  }
  const input = (ctx.message.text.split(' ')[1] || '').trim();
  const m = input.match(/\/d\/([A-Za-z0-9_-]+)/);
  const sheetId = m ? m[1] : (/^[A-Za-z0-9-_]+$/.test(input) ? input : null);
  if (!sheetId) return replyBold(ctx, 'Invalid URL or ID.');

  sheetMap.set(chatId, sheetId);
  await replyBold(ctx, `Sheet linked: ${sheetId}`);
  return beginSheetFlow(ctx);  // <— Trigger the next step immediately
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
// 4A) Sheet‑mode flow
// ─────────────────────────────────────────────────────────────────────────────
async function beginSheetFlow(ctx) {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);
  const sheetId= sheetMap.get(chatId);
  if (!sheetId) return replyBold(ctx, 'Send /setSheet first.');

  // ask creds?
  const creds = userCreds.get(chatId);
  if (!creds) {
    sess.step = 'sheet_await_email';
    return replyBold(ctx, 'Enter your Flyfone email:');
  }

  // show calendar for date
  sess.step = 'sheet_await_date';
  sessionMap.set(chatId, sess);
  ctx.session.calendarOptions = { defaultDate: dayjs().subtract(1,'day').toDate() };
  await ctx.reply('<b>Select a date to export:</b>', { reply_markup: calendar });
}

// Calendar handler for Sheet‑mode
bot.filter(ctx =>
  ctx.calendarSelectedDate
  && sessionMap.get(ctx.chat.id)?.step === 'sheet_await_date',
async ctx => {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);
  const dateStr= dayjs(ctx.calendarSelectedDate).format('YYYY-MM-DD');
  replyBold(ctx, `Exporting calls for ${dateStr}…`);
  // reuse your existing startFetchFlow to show team buttons → write sheet
  return startFetchFlow(ctx, sess.email, sess.pass, sheetMap.get(chatId), dateStr);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4B) Chat‑mode flow
// ─────────────────────────────────────────────────────────────────────────────
async function beginChatFlow(ctx) {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);

  // ask creds?
  const creds = userCreds.get(chatId);
  if (!creds) {
    sess.step = 'chat_await_email';
    sessionMap.set(chatId, sess);
    return replyBold(ctx, 'Enter your Flyfone email:');
  }

  // calendar for chat‑mode
  sess.step = 'chat_await_date';
  sessionMap.set(chatId, sess);
  ctx.session.calendarOptions = { defaultDate: dayjs().subtract(1,'day').toDate() };
  return ctx.reply('<b>Select a date to view in chat:</b>', { reply_markup: calendar });
}

// Calendar handler for Chat‑mode
bot.filter(ctx =>
  ctx.calendarSelectedDate
  && sessionMap.get(ctx.chat.id)?.step === 'chat_await_date',
async ctx => {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);
  const dateStr= dayjs(ctx.calendarSelectedDate).format('YYYY-MM-DD');
  replyBold(ctx, `Fetching calls for ${dateStr}…`);

  // download into memory
  const rows = await downloadFlyfoneReport(dateStr, sess.email, sess.pass);
  sessionMap.set(chatId, { ...sess, rows, dateStr });

  // show team buttons
  const rawTeams = rows.slice(1).map(r=>r[6]||'');
  const teams    = Array.from(new Set(rawTeams));
  const kb = new InlineKeyboard();
  teams.forEach(t => kb.text(t, `chat_team:${t}`).row());

  return ctx.reply('<b>Select a team:</b>', { parse_mode:'HTML', reply_markup: kb });
});

// Team → Agent in Chat‑mode
bot.callbackQuery(/^chat_team:(.+)$/, async ctx => {
  const chatId = ctx.chat.id;
  const { rows, dateStr } = sessionMap.get(chatId);
  const team   = ctx.match[1];
  const agents = Array.from(new Set(rows.slice(1).filter(r=>r[6]===team).map(r=>r[5])));
  const kb = new InlineKeyboard();
  agents.forEach(a => kb.text(a, `chat_agent:${team}|${a}`).row());
  await ctx.editMessageText(`<b>Team:</b> ${team}\n<b>Select an agent:</b>`, {
    parse_mode:'HTML', reply_markup: kb
  });
});

// Agent → Stats in Chat‑mode
bot.callbackQuery(/^chat_agent:(.+)\|(.+)$/, async ctx => {
  const chatId = ctx.chat.id;
  const [ , team, agent ] = ctx.match;
  const { rows, dateStr } = sessionMap.get(chatId);
  const filtered = rows.slice(1).filter(r=> r[6]===team && r[5]===agent );
  const total = filtered.length;
  const counts = filtered.reduce((acc,r)=>{
    const st=r[8]?.toString().trim(); acc[st]=(acc[st]||0)+1; return acc;
  }, {});
  await ctx.editMessageText(
    `<b>Name:</b> ${agent}\n`+
    `<b>Date:</b> ${dateStr}\n`+
    `<b>Calls:</b> ${total}\n`+
    `<b>Answered:</b> ${counts.Answered||0}\n`+
    `<b>Cancelled:</b> ${counts.Cancelled||0}\n`+
    `<b>Busy:</b> ${counts.Busy||0}`, 
    { parse_mode:'HTML' }
  );
  sessionMap.delete(chatId);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Credential prompts (shared) — guard on each step
// ─────────────────────────────────────────────────────────────────────────────
bot.on('message:text', async ctx => {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);
  if (!sess) return;

  // email prompt
  if (['sheet_await_email','chat_await_email'].includes(sess.step)) {
    sess.email = ctx.message.text.trim();
    sess.step  = sess.step.startsWith('sheet_') ? 'sheet_await_pass' : 'chat_await_pass';
    return replyBold(ctx, 'Now enter your Flyfone password:');
  }

  // pass prompt
  if (['sheet_await_pass','chat_await_pass'].includes(sess.step)) {
    const pass = ctx.message.text.trim();
    try {
jar.removeAllCookiesSync(); // ← clear old session
await ensureLoggedIn(sess.email, pass);
      userCreds.set(chatId, { email:sess.email, pass });
      // advance to date picker immediately
      sess.step = sess.step.startsWith('sheet_') ? 'sheet_await_date' : 'chat_await_date';
      sessionMap.set(chatId, sess);
      ctx.session.calendarOptions = { defaultDate: dayjs().subtract(1,'day').toDate() };
      return ctx.reply('<b>Please choose a date:</b>', { reply_markup: calendar });
    } catch (err) {
      sess.step = sess.step.startsWith('sheet_') ? 'sheet_await_email' : 'chat_await_email';
      return replyBold(ctx, 'Credentials invalid, try your email again.');
    }
  }
});
async function startFetchFlow(ctx, email, pass, sheetId, dateStr = null) {
  const ds = dateStr || dayjs().subtract(1, 'day').format('YYYY-MM-DD');

  try {
    const rows = await downloadFlyfoneReport(ds, email, pass);
    console.log('▶ startFetchFlow: total rows:', rows.length);

    // pull the “Team” column from each data row
    const raw = rows
      .slice(1)
      .map(r => r[6]?.toString() || '')
      .filter(t => t);
    console.log('▶ raw teams values:', Array.from(new Set(raw)).slice(0,10));

    // build unique list preserving original casing
    const teams = Array.from(new Set(raw)).map(label => ({
      key:   label.toLowerCase(),
      label,               // original
    }));
    console.log('▶ mapped teams array:', teams);

    // if truly empty, bail with user feedback instead of crash
    if (teams.length === 0) {
      console.warn('No team labels found for date', ds);
      return replyBold(ctx,
        `No teams found on ${ds}. Are you sure there were calls that day?`
      );
    }

    // stash for downstream
    sessionMap.set(ctx.chat.id, { rows, dateStr: ds, sheetId });

    // build buttons
    const kb = new InlineKeyboard();
    teams.forEach(t => kb.text(t.label, `team:${t.key}`).row());

    await ctx.reply('<b>Select a team:</b>', {
      reply_markup: kb,
      parse_mode:  'HTML',
    });

  } catch (err) {
    console.error('❌ startFetchFlow error:', err.stack || err);
    const msg = err.message === 'Incorrect email or password'
      ? 'Incorrect email or password. Please /fetch again to retry.'
      : `Error: ${err.message}`;
    await replyBold(ctx, msg);
  }
}


bot.start({
  onStart: info => console.log(`Polling as @${info.username}`)
});

// Utility to extract sheet ID
function extractSheetId(input) {
  const urlMatch = input.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9-_]+$/.test(input)) return input;
  return null;
}
