import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key && !url.includes('YOUR-PROJECT'))

// Only the public (publishable/anon) key is ever used in the browser. All authorisation is enforced by RLS + secure functions.
export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

/** Convert a Supabase / Postgres error into a stable { code, message } for the UI. */
export function dbError(e: unknown): { code: string; message: string } {
  const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)
  const m = /^(VALIDATION|FORBIDDEN|NEGATIVE_STOCK|STOCK_LENGTH_LOCKED|LAST_ADMIN|REVERSAL_BLOCKED|IMMUTABLE):\s*(.*)$/s.exec(msg)
  if (m) return { code: m[1], message: m[2] }
  return { code: 'ERROR', message: msg }
}
