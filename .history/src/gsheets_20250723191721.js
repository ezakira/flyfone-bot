import { google } from 'googleapis';
import 'dotenv/config';

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
} = process.env;

/**
 * Returns an authenticated Google Sheets client.
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
 * Overwrites the contents of Sheet1!A1 of the given spreadsheet.
 * @param {string} spreadsheetId 
 * @param {Array[]} rows  Two-dimensional array of values
 */
export async function writeToSheet(spreadsheetId, rows) {
  const sheets = getSheetsClient();

  // Clear old data
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Sheet1!A1:Z',
  });

  // Write new rows
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Sheet1!A1',
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });
}
