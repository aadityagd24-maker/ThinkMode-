import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_BLOCKOFF_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.PUBLIC_BLOCKOFF_SUPABASE_ANON_KEY;

export const blockoffSupabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storageKey: 'blockoff_supabase_auth',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
