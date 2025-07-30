// state.js
import { supabase } from './supabase.js';
import { CookieJar } from 'tough-cookie';


/**
 * Load flyfoneCreds, sessionMap, sheetMap from disk at startup.
 */

/**
 * Save flyfoneCreds, sessionMap, sheetMap to disk before shutdown.
 */

/**
 * Retrieve a user's Google OAuth refresh token from Supabase.
 * @param {number} chatId
 * @returns {Promise<string|null>}
 */
export async function getRefreshToken(chatId) {
  const { data, error } = await supabase
    .from('user_tokens')
    .select('refresh_token')
    .eq('telegram_id', chatId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching refresh token:', error);
    throw error;
  }
  return data?.refresh_token ?? null;
}

/**
 * Delete a user's Google OAuth refresh token from Supabase.
 * @param {number} chatId
 * @returns {Promise<void>}
 */
export async function deleteRefreshToken(chatId) {
  const { error } = await supabase
    .from('user_tokens')
    .delete()
    .eq('telegram_id', chatId);

  if (error) {
    console.error('Error deleting refresh token:', error);
    throw error;
  }
}

/**
 * Save or update a user's Google OAuth refresh token in Supabase.
 * @param {number} chatId
 * @param {string} refresh_token
 * @returns {Promise<void>}
 */
export async function saveRefreshToken(chatId, refresh_token) {
  const { error } = await supabase
    .from('user_tokens')
    .upsert({ telegram_id: chatId, refresh_token }, { onConflict: 'telegram_id' });


  if (error) {
    console.error('Error saving refresh token:', error);
    throw error;
  }
}

/**
 * Retrieve Flyfone credentials from Supabase.
 * @param {number} chatId
 * @returns {Promise<{email: string, pass: string} | null>}
 */
export async function getFlyfoneCreds(chatId) {
  const { data, error } = await supabase
    .from('flyfone_creds')
    .select('email, pass')
    .eq('telegram_id', chatId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching Flyfone credentials:', error);
    throw error;
  }
  return data ?? null;
}

/**
 * Save or update Flyfone credentials in Supabase.
 * @param {number} chatId
 * @param {string} email
 * @param {string} pass
 * @returns {Promise<void>}
 */
export async function saveFlyfoneCreds(chatId, email, pass) {
  console.log(`💾 saveFlyfoneCreds(${chatId}, ${email})`);
  const { data, error } = await supabase
    .from('flyfone_creds')
    .upsert({ telegram_id: chatId, email, pass });

  if (error) console.error('❌ saveFlyfoneCreds error:', error);
 else       console.log('✔️ saveFlyfoneCreds OK:', data);
  return { data, error };
}

/**
 * Delete Flyfone credentials from Supabase.
 * @param {number} chatId
 * @returns {Promise<void>}
 */
export async function deleteFlyfoneCreds(chatId) {
  const { error } = await supabase
    .from('flyfone_creds')
    .delete()
    .eq('telegram_id', chatId);

  if (error) {
    console.error('Error deleting Flyfone credentials:', error);
    throw error;
  }
}

/**
 * Retrieve session data from Supabase.
 * @param {number} chatId
 * @returns {Promise<object | null>}
 */
export async function getSession(chatId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('session_json')
    .eq('telegram_id', chatId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching session:', error);
    throw error;
  }
  return data ? JSON.parse(data.session_json) : null;
}

/**
 * Save or update session data in Supabase.
 * @param {number} chatId
 * @param {object} sessionObj
 * @returns {Promise<void>}
 */
export async function saveSession(chatId, sessionObj) {
  const { error } = await supabase
    .from('sessions')
    .upsert({ telegram_id: chatId, session_json: JSON.stringify(sessionObj) });

  if (error) {
    console.error('Error saving session:', error);
    throw error;
  }
}

/**
 * Delete session data from Supabase.
 * @param {number} chatId
 * @returns {Promise<void>}
 */
export async function deleteSession(chatId) {
  const { error } = await supabase
    .from('sessions')
    .delete()
    .eq('telegram_id', chatId);

  if (error) {
    console.error('Error deleting session:', error);
    throw error;
  }
}

/**
 * Retrieve sheet ID from Supabase.
 * @param {number} chatId
 * @returns {Promise<string | null>}
 */
export async function getSheet(chatId) {
  const { data, error } = await supabase
    .from('sheet_map')
    .select('sheet_id')
    .eq('telegram_id', chatId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching sheet ID:', error);
    throw error;
  }
  return data?.sheet_id ?? null;
}

/**
 * Save or update sheet ID in Supabase.
 * @param {number} chatId
 * @param {string} sheetId
 * @returns {Promise<void>}
 */
export async function saveSheet(chatId, sheetId) {
  const { error } = await supabase
    .from('sheet_map')
    .upsert({ telegram_id: chatId, sheet_id: sheetId });

  if (error) {
    console.error('Error saving sheet ID:', error);
    throw error;
  }
}

/**
 * Delete sheet ID from Supabase.
 * @param {number} chatId
 * @returns {Promise<void>}
 */
export async function deleteSheet(chatId) {
  const { error } = await supabase
    .from('sheet_map')
    .delete()
    .eq('telegram_id', chatId);

  if (error) {
    console.error('Error deleting sheet ID:', error);
    throw error;
  }
}

/**
 * Retrieve cookies from Supabase.
 * @param {number} chatId
 * @returns {Promise<CookieJar>}
 */
export async function loadCookies(chatId) {
  const { data, error } = await supabase
    .from('cookies')
    .select('cookie_json')
    .eq('telegram_id', chatId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching cookies:', error);
    return new CookieJar(); // Return new jar instead of throwing
  }
  return data ? CookieJar.fromJSON(JSON.parse(data.cookie_json)) : new CookieJar();
}
/**
 * Save or update cookies in Supabase.
 * @param {number} chatId
 * @param {CookieJar} cookieJar
 * @returns {Promise<void>}
 */
export async function saveCookies(chatId, cookieJar) {
  const { error } = await supabase
    .from('cookies')
    .upsert({ telegram_id: chatId, cookie_json: JSON.stringify(cookieJar.toJSON()) });

  if (error) {
    console.error('Error saving cookies:', error);
    throw error;
  }
}

export async function removeAllCookies(chatId) {
  const { error } = await supabase
    .from('cookies')
    .delete()
    .eq('telegram_id', chatId);

  if (error) {
    console.error('Error deleting cookies:', error);
    throw error;
  }
}