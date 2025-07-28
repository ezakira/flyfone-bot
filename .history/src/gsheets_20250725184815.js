import { google } from 'googleapis';
import 'dotenv/config';

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
} = process.env;

export function getSheetsClientForUser(chatId) {
  const creds = userCreds.get(chatId);
  if (!creds) throw new Error('User not authorized');

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.BOT_REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: creds.refresh_token });

  return google.sheets({ version: 'v4', auth });
}
/**
 * Writes rows into the sheet, either overwriting or appending.
 * @param {string} spreadsheetId
 * @param {Array[]} rows           Two-dimensional array of values
 * @param {boolean} overwrite      If true, clear and write at A1; else append
 */
export async function writeToSheet(spreadsheetId, rows, overwrite = false) {
  const sheets = getSheetsClient();
  const range = 'Sheet1!A1:Z';

  if (overwrite) {
    // 1) Clear the existing data…
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range,
    });
    // 2) Write fresh at A1
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  } else {
    // Append mode: use the append endpoint
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Sheet1!A1',        // append to the sheet
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
  }
}
