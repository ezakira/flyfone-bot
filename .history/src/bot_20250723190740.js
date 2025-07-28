import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import dayjs from 'dayjs';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeToSheet } from './gsheets.js';

// ---------- Flyfone download utilities ----------

// Resolve __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to persist cookies (will live in ./cookies.json)
const COOKIE_FILE = path.resolve(__dirname, '../cookies.json');

// Load or initialize a cookie jar
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
    // not logged in
  }

  console.log('Logging in to Flyfone…');
  const loginPage = await client.get(`${FLYFONE_BASE}/login`, {
    validateStatus: s => s === 200,
  });
  const match = loginPage.data.match(/name="csrf_webcall" value="([^"]+)"/);
  if (!match) throw new Error('CSRF token not found');
  const csrf = match[1];

  const resp = await client.post(
    `${FLYFONE_BASE}/login`,
    new URLSearchParams({ csrf_webcall: csrf, username: email, password }),
    {
      maxRedirects: 0,
      validateStatus: s => s === 302 || s === 303,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${FLYFONE_BASE}/login`,
        Origin: FLYFONE_BASE,
      },
    }
  );
  console.log(`Login HTTP status: ${resp.status}`);
  saveCookieJar(jar);
  console.log('Login successful, cookies saved.');
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

// ---------- Telegram bot logic ----------

const sheetMap    = new Map(); // chatId → sheetId
const sessionMap  = new Map(); // chatId → fetch session
const userCreds   = new Map(); // chatId → { email, pass }

const bot = new Bot(process.env.BOT_TOKEN);

function extractSheetId(input) {
  const urlMatch = input.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9-_]+$/.test(input)) return input;
  return null;
}

bot.command('start', ctx => ctx.reply('Up and running via polling.'));

// Link a Google Sheet
bot.command('setSheet', async ctx => {
  const input = ctx.message.text.split(' ')[1] || '';
  const sheetId = extractSheetId(input);
  if (!sheetId) return ctx.reply('Please send a valid sheet URL or ID.');
  sheetMap.set(ctx.chat.id, sheetId);
  await ctx.reply(`Sheet linked: ${sheetId}`);
});

// Trigger fetch flow
bot.command('fetch', async ctx => {
  const chatId = ctx.chat.id;
  const sheetId = sheetMap.get(chatId);
  if (!sheetId) return ctx.reply('No sheet linked. Use /setSheet <URL or ID>.');

  const creds = userCreds.get(chatId);
  if (!creds) {
    sessionMap.set(chatId, { step: 'await_email', sheetId });
    return ctx.reply('Please enter your Flyfone email:');
  }
  return startFetchFlow(ctx, creds.email, creds.pass, sheetId);
});

// Logout
bot.command('logout', async ctx => {
  const chatId = ctx.chat.id;
  if (userCreds.delete(chatId)) {
    return ctx.reply('Logged out. Use /fetch to login again.');
  }
  ctx.reply('You’re not logged in.');
});

// Handle credential prompts
bot.on('message:text', async ctx => {
  const chatId = ctx.chat.id;
  const sess = sessionMap.get(chatId);
  if (!sess || !['await_email','await_pass'].includes(sess.step)) return;

  if (sess.step === 'await_email') {
    sess.email = ctx.message.text.trim();
    sess.step = 'await_pass';
    sessionMap.set(chatId, sess);
    return ctx.reply('Got it. Now enter your Flyfone password:');
  }

  if (sess.step === 'await_pass') {
    sess.pass = ctx.message.text;
    userCreds.set(chatId, { email: sess.email, pass: sess.pass });
    sessionMap.delete(chatId);
    return startFetchFlow(ctx, sess.email, sess.pass, sess.sheetId);
  }
});

// Core fetch → team selection flow
async function startFetchFlow(ctx, email, pass, sheetId) {
  await ctx.reply('Downloading Flyfone report…');
  const dateStr = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  try {
    const rows = await downloadFlyfoneReport(dateStr, email, pass);

    const teams = new Set(
      rows.slice(1)
          .map(r => (r[6]||'').toString().toLowerCase())
          .filter(t => t)
    );
    if (!teams.size) throw new Error('No team data found');

    sessionMap.set(ctx.chat.id, { rows, dateStr, sheetId });

    const kb = new InlineKeyboard();
    teams.forEach(t => kb.text(t, `team:${t}`).row());
    await ctx.reply('Select a team:', { reply_markup: kb });

  } catch (err) {
    console.error(err);
    await ctx.reply(`❌ Error: ${err.message}`);
  }
}

// Write filtered data back to sheet
bot.callbackQuery(/^team:(.+)$/, async ctx => {
  const chatId = ctx.chat.id;
  const teamKey = ctx.match[1];
  const sess = sessionMap.get(chatId);
  if (!sess) return ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });

  const { rows, dateStr, sheetId } = sess;
  const filtered = rows.slice(1).filter(r => r[6]?.toString().toLowerCase() === teamKey);

  const output = [[
    'Caller','Team','Callee','Status','Duration (s)','Talktime (s)','Hangup By','Call Date','Call Time','End Time'
  ]];
  filtered.forEach(r => output.push([r[5],r[6],r[7],r[8],r[9],r[10],r[11],r[1],r[2],r[3]]));

  try {
    await writeToSheet(sheetId, output);
    await ctx.editMessageText(`✅ Wrote ${filtered.length} rows for team "${teamKey}" on ${dateStr}`);
  } catch (err) {
    console.error(err);
    await ctx.editMessageText(`❌ Write failed: ${err.message}`);
  } finally {
    sessionMap.delete(chatId);
  }
});

bot.start({
  onStart: info => console.log(`🤖 Polling as @${info.username}`)
});
