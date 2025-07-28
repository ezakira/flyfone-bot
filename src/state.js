// state.js
import fs from 'fs';
import path from 'path';

const STATE_FILE = path.resolve('./.bot_state.json');

// In-memory state maps
export const flyfoneCreds = new Map();
export const googleCreds  = new Map();
export const sessionMap   = new Map();
export const sheetMap     = new Map();

/** Load from disk at startup */
export function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));

  for (const [k, v] of Object.entries(raw.flyfoneCreds || {})) flyfoneCreds.set(+k, v);
  for (const [k, v] of Object.entries(raw.googleCreds || {}))  googleCreds.set(+k, v);
  for (const [k, v] of Object.entries(raw.sessionMap || {}))   sessionMap.set(+k, v);
  for (const [k, v] of Object.entries(raw.sheetMap || {}))     sheetMap.set(+k, v);
}

/** Save all maps to disk */
export function saveState() {
  const serialize = map => Object.fromEntries([...map.entries()]);
  const data = {
    flyfoneCreds: serialize(flyfoneCreds),
    googleCreds:  serialize(googleCreds),
    sessionMap:   serialize(sessionMap),
    sheetMap:     serialize(sheetMap),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}
