import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import dayjs from 'dayjs';
import { writeToSheet } from './gsheets.js';

// In-memory stores
const sheetMap = new Map();   // chatId -> sheetId
const sessionMap = new Map(); // chatId -> session data
const userCreds = new Map();  // chatId -> { email, pass }

const bot = new Bot(process.env.BOT_TOKEN);

// Helper: extract sheet ID from URL or raw
function extractSheetId(input) {
  const urlMatch = input.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9-_]+$/.test(input)) return input;
  return null;
}

bot.command("start", ctx => ctx.reply("Up and running via polling."));

// /setSheet — link a Google Sheet by URL or ID
bot.command('setSheet', async (ctx) => {
  const input = ctx.message.text.split(' ')[1] || '';
  const sheetId = extractSheetId(input);
  if (!sheetId) {
    return ctx.reply('Please send a valid sheet URL or ID.');
  }
  sheetMap.set(ctx.chat.id, sheetId);
  await ctx.reply(`Sheet linked: ${sheetId}`);
});

// /fetch — trigger user credential or direct fetch flow
bot.command('fetch', async (ctx) => {
  const chatId = ctx.chat.id;
  const sheetId = sheetMap.get(chatId);
  if (!sheetId) {
    return ctx.reply('No sheet linked. Use /setSheet <URL or ID>.');
  }

  // Check if credentials stored
  const creds = userCreds.get(chatId);
  if (!creds) {
    // prompt for email
    sessionMap.set(chatId, { step: 'await_email', sheetId });
    return ctx.reply('Please enter your Flyfone email:');
  }

  // already have creds, proceed
  return startFetchFlow(ctx, creds.email, creds.pass, sheetId);
});

// /logout — clear stored Flyfone credentials
bot.command('logout', async (ctx) => {
  const chatId = ctx.chat.id;
  if (userCreds.has(chatId)) {
    userCreds.delete(chatId);
    await ctx.reply('You have been logged out. Use /fetch again to log in with a different account.');
  } else {
    await ctx.reply('You’re not currently logged in.');
  }
});


// Message handler for credential prompts
bot.on('message:text', async (ctx) => {
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
    // save creds
    userCreds.set(chatId, { email: sess.email, pass: sess.pass });
    sessionMap.delete(chatId);
    return startFetchFlow(ctx, sess.email, sess.pass, sess.sheetId);
  }
});

// Core flow: fetch report, show team selection
async function startFetchFlow(ctx, email, pass, sheetId) {
  await ctx.reply('Downloading Flyfone report…');
  const dateStr = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  try {
    const rows = await downloadFlyfoneReport(dateStr, email, pass);
    // gather unique teams
    const teamSet = new Set();
    rows.slice(1).forEach(r => {
      const team = (r[6]||'').toString().toLowerCase();
      if (team) teamSet.add(team);
    });
    if (!teamSet.size) throw new Error('No team data found');

    // store for callback
    sessionMap.set(ctx.chat.id, { rows, dateStr, sheetId });

    const kb = new InlineKeyboard();
    Array.from(teamSet).forEach(t => kb.text(t, `team:${t}`).row());
    await ctx.reply('Select a team:', { reply_markup: kb });
  } catch (err) {
    console.error(err);
    await ctx.reply(`❌ Error: ${err.message}`);
  }
}

// Handle team selection callback
bot.callbackQuery(/^team:(.+)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  const teamKey = ctx.match[1];
  const sess = sessionMap.get(chatId);
  if (!sess) return ctx.answerCallbackQuery({ text: 'Session expired.', show_alert: true });
  const { rows, dateStr, sheetId } = sess;

  // filter and map columns
  const filtered = rows.slice(1).filter(r => r[6]?.toString().toLowerCase() === teamKey);
  const output = [[
    'Caller','Team','Callee','Status','Duration (s)','Talktime (s)','Hangup By','Call Date','Call Time','End Time'
  ]];
  filtered.forEach(r => output.push([
    r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[1], r[2], r[3]
  ]));

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
  onStart: (info) => console.log("Bot started as", info.username)
});