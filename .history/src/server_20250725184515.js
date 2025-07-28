// server.js
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import { Bot } from 'grammy';
import { userCreds } from './state.js';  // see step 3

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  BOT_REDIRECT_URI,
  BOT_TOKEN,
} = process.env;

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  BOT_REDIRECT_URI
);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/oauth2callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send('Missing code or state.');
  }

  // state was JSON.stringify({ chatId, sheetId })
  const { chatId, sheetId } = JSON.parse(decodeURIComponent(state));

  try {
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      // force a prompt: you'll need `prompt: 'consent'` in generateAuthUrl
      throw new Error('No refresh token returned.');
    }

    // 1) store per‐user credentials
    userCreds.set(chatId, {
      refresh_token: tokens.refresh_token,
      sheetId,
    });

    // 2) notify user in Telegram
    const bot = new Bot(BOT_TOKEN);
    await bot.api.sendMessage(
      chatId,
      '<b>Authorized! Now /fetch and I’ll write to your sheet.</b>',
      { parse_mode: 'HTML' }
    );

    res.send('<b>Authorization successful—you can close this tab.</b>',
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.listen(6565, () => console.log('listening on port 6565...'));
