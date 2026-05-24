import { createClient } from '@supabase/supabase-js'

// Cloud config comes from Vite env (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY).
// The anon/publishable key is public by design — RLS on the `teams` table is the
// real security boundary — but it's still supplied via env so it isn't committed.
const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

// When env isn't set (a fork, or a build without cloud configured) the app still
// runs fully as a local line-builder — the "My Teams" cloud feature just stays
// hidden. So everything downstream guards on `supabaseConfigured`.
export const supabaseConfigured = Boolean(url && key)

export const supabase = supabaseConfigured
  ? createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null
