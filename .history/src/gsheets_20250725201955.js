import { google } from 'googleapis';
import 'dotenv/config';
import { userCreds } from './state.js';

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
} = process.env;

/**
 * Bot‑level Sheets client, using a single refresh token.
 */
function getSheetsClient() {
  const auth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.sheets({ version: 'v4', auth });
}

/**
 * Per‑user Sheets client (if you ever need individual tokens).
 */
export function getSheetsClientForUser(chatId) {
  const creds = userCreds.get(chatId);
  if (!creds) throw new Error('User not authorized');

  const auth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    process.env.BOT_REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: creds.refresh_token });
  return google.sheets({ version: 'v4', auth });
}

/**
 * Writes `rows` into the given spreadsheet.  
 * If `overwrite` is true it clears first, otherwise it appends.
 */
export async function writeToSheet(spreadsheetId, rows, overwrite = false) {
  const sheets = getSheetsClient();      // ← now defined!
  const fullRange = 'Sheet1!A1:Z';

  if (overwrite) {
    // 1) clear existing data
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: fullRange,
    });
    // 2) write fresh starting at A1
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  } else {
    // append mode
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
  }
}
