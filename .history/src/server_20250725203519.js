// server.js
import 'dotenv/config';                      // ← load .env early
import express from 'express';
import bodyParser from 'body-parser';
import { google } from 'googleapis';
import { Bot } from 'grammy';
import { userCreds } from './state.js';

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  BOT_REDIRECT_URI,
  BOT_TOKEN,
} = process.env;

// Create a fresh OAuth2 client here
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  BOT_REDIRECT_URI
);

const bot = new Bot(BOT_TOKEN);
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/oauth2callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send('Missing code or state.');
  }

  // state was JSON.stringify({ chatId })
  let chatId;
  try {
    ({ chatId } = JSON.parse(decodeURIComponent(state)));
  } catch {
    return res.status(400).send('Invalid state parameter.');
  }

  try {
    // 1) exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      // If Google doesn’t return a refresh_token, force re-consent next time
      console.warn('No refresh token returned; user may need to re-consent.');
    }

    // 2) store just the refresh token
    userCreds.set(chatId, {
      refresh_token: tokens.refresh_token,
    });

    // 3) notify user in Telegram
    await bot.api.sendMessage(
      chatId,
'<b>Authorized! Now send /sheet &lt;URL or ID&gt; to link your sheet.</b>',
    { parse_mode: 'HTML' }    );

    // 4) inform the browser
    res.send('<b>Authorized! Now send /sheet &lt;URL or ID&gt; to link your sheet.</b>',
    { parse_mode: 'HTML' });
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

const PORT = process.env.PORT || 6565;
app.listen(PORT, () => {
  console.log(`OAuth2 callback server listening on http://localhost:${PORT}`);
});
