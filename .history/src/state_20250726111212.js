// state.js

// per‑chat Flyfone login creds:
export const flyfoneCreds = new Map();  
// key: chatId (number)  
// value: { email: string, pass: string }

// per‑chat Google OAuth tokens:
export const googleCreds = new Map();  
// key: chatId (number)  
// value: { refresh_token: string, sheetId?: string }
