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

// Telegram bot logic

const sheetMap    = new Map(); // chatId → sheetId
const sessionMap  = new Map(); // chatId → fetch session
const userCreds   = new Map(); // chatId → { email, pass }

const bot = new Bot(process.env.BOT_TOKEN);

bot.use(session({ initial: () => ({ calendarOptions: {} }) }));
const calendar = new Calendar(ctx => ctx.session.calendarOptions);
bot.use(calendar);

// Helper to send bold replies
function replyBold(ctx, text, extra = {}) {
  return ctx.reply(`<b>${text}</b>`, { parse_mode: 'HTML', ...extra });
}

bot.command('start', async ctx => {
  const kb = new InlineKeyboard()
    .text('Yes, link a sheet', 'linkSheet:yes')
    .text('No, keep in chat', 'linkSheet:no');
  await ctx.reply('Do you want to connect your Google Sheet?', {
    reply_markup: kb
  });
});

// 2. Handle their choice
bot.callbackQuery(/^linkSheet:(yes|no)$/, async ctx => {
  const chatId = ctx.chat.id;
  const choice = ctx.match[1]; // "yes" or "no"
  const sess = sessionMap.get(chatId) || {};
  sess.connectSheet = (choice === 'yes');
  sessionMap.set(chatId, sess);

  await ctx.answerCallbackQuery();
  if (choice === 'yes') {
    return replyBold(ctx, 'Please send "/setSheet ID or URL".');
  } else {
    return replyBold(ctx, 'Okay, results will be shown here in chat.');
  }
});
// /fetch → either ask for creds or show the date‑picker
async function beginFetch(ctx) {
  const chatId = ctx.chat.id;
  const sess    = sessionMap.get(chatId) || {};
  const sheetId = sheetMap.get(chatId);

   if (sess.connectSheet && !sheetId) {
    return replyBold(ctx, 'No sheet linked. Use /setSheet URL or ID.');
  }

  const creds = userCreds.get(chatId);
  if (!creds) {
    sessionMap.set(chatId, { step: 'await_email', sheetId });
    return replyBold(ctx, 'Please enter your Flyfone email:');
  }

  // move to date selection
  sessionMap.set(chatId, {
    step:    'await_date',
    sheetId,
    email:   creds.email,
    pass:    creds.pass,
  });
  // default calendar to yesterday
  ctx.session.calendarOptions = {
    defaultDate: dayjs().subtract(1, 'day').toDate(),
  };
  await ctx.reply('<b>Please choose a date for the report:</b>', {
    reply_markup: calendar,
  });
};

// /setSheet <URL or ID>
bot.command('setSheet', async ctx => {
  const input   = ctx.message.text.split(' ')[1] || '';
  const sheetId = extractSheetId(input);
  if (!sheetId) return replyBold(ctx, 'Please send a valid sheet URL or ID.');
  sheetMap.set(ctx.chat.id, sheetId);
    const sess = sessionMap.get(ctx.chat.id) || {};
  sess.sheetId = sheetId;
  sessionMap.set(ctx.chat.id, sess);
  await replyBold(ctx, `Sheet linked: ${sheetId}`);
  return beginFetch(ctx);
});

bot.command('fetch', beginFetch);


// /logout
bot.command('logout', ctx => {
  const chatId = ctx.chat.id;
  if (userCreds.delete(chatId)) {
    return replyBold(ctx, 'Logged out. Use /fetch to login again.');
  }
  return replyBold(ctx, 'You’re not logged in.');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) MESSAGE HANDLER FOR CREDENTIAL PROMPTS
// ─────────────────────────────────────────────────────────────────────────────

bot.on('message:text', async ctx => {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);
  if (!sess) return;

  // 3a) Credentials flow
  if (sess.step === 'await_email') {
    sess.email = ctx.message.text.trim();
    sess.step  = 'await_pass';
    sessionMap.set(chatId, sess);
    return replyBold(ctx, 'Now enter your Flyfone password:');
  }
  if (sess.step === 'await_pass') {
    const pass = ctx.message.text.trim();
    try {
      await ensureLoggedIn(sess.email, pass);
      userCreds.set(chatId, { email: sess.email, pass });
      // advance immediately to date picker
      sess.step = 'await_date';
      sess.email = sess.email;
      sess.pass  = pass;
      sessionMap.set(chatId, sess);
      ctx.session.calendarOptions = { defaultDate: dayjs().subtract(1, 'day').toDate() };
      return ctx.reply('<b>Please choose a date for the report:</b>', { reply_markup: calendar });
    } catch (err) {
      if (err.message === 'Incorrect email or password') {
        sess.step = 'await_email';
        sessionMap.set(chatId, sess);
        return replyBold(ctx, 'Incorrect Email or Password! please enter your Flyfone email again:');
      }
      sessionMap.delete(chatId);
      return replyBold(ctx, `Error validating credentials: ${err.message}`);
    }
  }

  // 3b) Catch date only if we’re explicitly waiting for it
  if (sess.step === 'await_date') {
    const date = ctx.message.text.trim();
    // clear step so we don’t re‑enter
    sess.step = null;
    sessionMap.set(chatId, sess);
    return startFetchFlow(ctx, sess.email, sess.pass, sess.sheetId, date);
  }
});


// 1) Team selected → if connectSheet, write out; otherwise ask “select agent”
bot.callbackQuery(/^team:(.+)$/, async ctx => {
  const chatId  = ctx.chat.id;
  const teamKey = ctx.match[1];              // lowercase key
  const sess    = sessionMap.get(chatId);
  if (!sess) return ctx.answerCallbackQuery({ text:'Session expired', show_alert:true });

  // find matching rows
  const allRows = sess.rows.slice(1);
  const rows    = allRows.filter(r => r[6].toString().toLowerCase() === teamKey);

  // 4a) if they opted into Sheets: write & done
  if (sess.connectSheet) {
    const output = [
      ['Caller','Team','Callee','Status','Duration','Talktime','Hangup','Date','Time','End'],
      ...rows.map(r => [r[5],r[6],r[7],r[8],r[9],r[10],r[11],r[1],r[2],r[3]])
    ];
    await writeToSheet(sess.sheetId, output);
    await ctx.editMessageText(
      `<b>Wrote ${rows.length} rows for team "${teamKey}" on ${sess.dateStr}</b>`,
      { parse_mode:'HTML' }
    );
    sessionMap.delete(chatId);
    return;
  }
  // 4b) otherwise ask for agent, preserving original casing
  sess.team = teamKey;
  sess.step = 'await_agent';
  sessionMap.set(chatId, sess);

  // build [{key,label}] so labels stay nice
  const agents = Array.from(
    allRows
      .filter(r => r[6].toString().toLowerCase() === teamKey)
      .reduce((set, r) => set.add(r[5]), new Set())
  );

  const kb = new InlineKeyboard();
  agents.forEach(agent => {
    kb.text(agent, `agent:${agent}`);
  });

  await ctx.editMessageText(
    `<b>Team:</b> ${agents.length?'':'(no agents)'}\n<b>Select an agent:</b>`,
    { parse_mode:'HTML', reply_markup: kb }
  );
});
// 2) Agent selected → ask for date
bot.callbackQuery(/^agent:(.+)$/, async ctx => {
  const chatId = ctx.chat.id;
  const agent  = ctx.match[1];
  const sess   = sessionMap.get(chatId);
  if (!sess || sess.step !== 'await_agent') {
    return ctx.answerCallbackQuery({ text:'Invalid step', show_alert:true });
  }

  sess.agent = agent;
  sess.step  = 'await_final_date';
  sessionMap.set(chatId, sess);

  await ctx.editMessageText(
    `<b>Agent:</b> ${agent}\nPlease enter a date (YYYY-MM-DD):`,
    { parse_mode:'HTML' }
  );
});


// ─────────────────────────────────────────────────────────────────────────────
// 6) Final date handler → show stats and cleanup
// ─────────────────────────────────────────────────────────────────────────────
bot.on('message:text', async ctx => {
  const chatId = ctx.chat.id;
  const sess   = sessionMap.get(chatId);
  if (!sess || sess.step !== 'await_final_date') return;

  const date = ctx.message.text.trim();
  const rows = sess.rows.slice(1).filter(r =>
    r[6].toString().toLowerCase() === sess.team &&
    r[5] === sess.agent &&
    r[1] === date
  );

  // compute stats
  const total = rows.length;
  const counts = rows.reduce((acc, r) => {
    acc[r[8]] = (acc[r[8]]||0) + 1;
    return acc;
  }, {});

  await ctx.replyWithHTML(
    `<b>Name:</b> ${sess.agent}\n` +
    `<b>Date:</b> ${date}\n` +
    `<b>Calls:</b> ${total}\n` +
    `<b>Answered:</b> ${counts.Answered||0}\n` +
    `<b>Cancelled:</b> ${counts.Cancelled||0}\n` +
    `<b>Busy:</b> ${counts.Busy||0}`
  );

  sessionMap.delete(chatId);
});

async function startFetchFlow(ctx, email, pass, sheetId, dateStr = null) {
  const ds = dateStr || dayjs().subtract(1, 'day').format('YYYY-MM-DD');

  try {
    const rows = await downloadFlyfoneReport(ds, email, pass);

    const teams = new Set(
      rows.slice(1)
          .map(r => (r[6]||'').toString().toLowerCase())
          .filter(t => t)
    );
    if (!teams.size) throw new Error('No team data found');

    sessionMap.set(ctx.chat.id, { rows, dateStr: ds, sheetId });

    const kb = new InlineKeyboard();
    teams.forEach(t => kb.text(t, `team:${t}`).row());
    await ctx.reply('<b>Select a team:</b>', {
      reply_markup: kb,
      parse_mode: 'HTML',
    });

  } catch (err) {
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
