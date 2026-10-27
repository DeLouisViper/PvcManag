// Supabase Edge Function: admin-users
// Creates user accounts and resets passwords. Needs the service-role key, which Supabase injects into Edge Functions
// automatically (SUPABASE_SERVICE_ROLE_KEY). It is NEVER sent to the browser. The caller must be a signed-in, active ADMIN.
//
// Deploy:  supabase functions deploy admin-users
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const auth = req.headers.get('Authorization')
  if (!auth) return json(401, { error: 'Missing Authorization header' })

  // 1. who is calling?
  const caller = createClient(url, anon, { global: { headers: { Authorization: auth } } })
  const { data: u, error: uerr } = await caller.auth.getUser()
  if (uerr || !u.user) return json(401, { error: 'Invalid session' })

  // 2. are they an active admin? (checked with the service client against the database, never from the token)
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: me } = await admin.from('profiles').select('role, active').eq('id', u.user.id).maybeSingle()
  if (!me || !me.active || me.role !== 'admin') return json(403, { error: 'Administrator rights required' })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json(400, { error: 'Invalid JSON' }) }
  const action = String(body.action ?? '')

  const strongEnough = (p: unknown): p is string => typeof p === 'string' && p.length >= 8 && p.length <= 72

  if (action === 'create') {
    const email = String(body.email ?? '').trim().toLowerCase()
    const full_name = String(body.full_name ?? '').trim().slice(0, 120)
    const role = body.role === 'admin' ? 'admin' : 'user'
    const password = body.password
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Invalid email' })
    if (!strongEnough(password)) return json(400, { error: 'Password must be 8-72 characters' })

    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name } })
    if (error || !data.user) return json(400, { error: error?.message ?? 'Could not create user' })

    // the profile row is created by the database trigger as an inactive "user"; activate / promote / flag it here
    const { error: perr } = await admin.from('profiles').update({ role, active: true, full_name: full_name || email.split('@')[0], must_change_password: true }).eq('id', data.user.id)
    if (perr) return json(500, { error: perr.message })
    await admin.from('audit_logs').insert({ user_id: u.user.id, action: 'user.create', entity: 'profiles', entity_id: data.user.id, details: { email, role } })
    return json(200, { ok: true, id: data.user.id })
  }

  if (action === 'reset_password') {
    const id = String(body.user_id ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json(400, { error: 'Invalid user id' })
    if (!strongEnough(body.password)) return json(400, { error: 'Password must be 8-72 characters' })
    const { error } = await admin.auth.admin.updateUserById(id, { password: body.password })
    if (error) return json(400, { error: error.message })
    await admin.from('profiles').update({ must_change_password: true }).eq('id', id)
    await admin.from('audit_logs').insert({ user_id: u.user.id, action: 'user.reset_password', entity: 'profiles', entity_id: id, details: {} })
    return json(200, { ok: true })
  }

  return json(400, { error: 'Unknown action' })
})
