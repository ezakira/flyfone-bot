// supabase.js
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;

if (!URL || !KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY in environment');
}

export const supabase = createClient(URL, KEY);
