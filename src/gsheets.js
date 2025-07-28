// gsheets.js
import { google } from 'googleapis';
import 'dotenv/config';
import { googleCreds } from './state.js';
const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
} = process.env;

/**
 * Per‑user Sheets client: uses the individual user’s refresh token.
 */
export function getSheetsClientForUser(chatId) {
const creds = googleCreds.get(chatId);
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
 * Writes `rows` into the given spreadsheet on behalf of `chatId`.
 * If `overwrite` is true it clears first, otherwise it appends.
 *
 * @param {number} chatId
 * @param {string} spreadsheetId
 * @param {Array[]} rows
 * @param {boolean} overwrite
 */
export async function writeToSheet(
  chatId,
  spreadsheetId,
  rows,
  overwrite = false
) {
  const sheets = getSheetsClientForUser(chatId);
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
