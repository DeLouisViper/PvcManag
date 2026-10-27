import type { Session } from '@supabase/supabase-js'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Profile } from '../lib/dbTypes'
import { isConfigured, supabase } from '../lib/supabase'

type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut'; error?: 'disabled' | 'noProfile' }
  | { status: 'signedIn'; session: Session; profile: Profile }

interface Ctx {
  state: AuthState
  signIn: (email: string, password: string) => Promise<boolean>
  signOut: () => Promise<void>
  reloadProfile: () => Promise<void>
}
const AuthCtx = createContext<Ctx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })

  const load = useCallback(async (session: Session | null) => {
    if (!session) {
      setState({ status: 'signedOut' })
      return
    }
    const { data, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle()
    if (error || !data) {
      await supabase.auth.signOut()
      setState({ status: 'signedOut', error: 'noProfile' })
      return
    }
    const profile = data as Profile
    if (!profile.active) {
      await supabase.auth.signOut()
      setState({ status: 'signedOut', error: 'disabled' })
      return
    }
    setState({ status: 'signedIn', session, profile })
  }, [])

  useEffect(() => {
    if (!isConfigured) {
      setState({ status: 'signedOut' })
      return
    }
    let alive = true
    void supabase.auth.getSession().then(async ({ data }) => {
      if (alive) await load(data.session)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') setState((s) => (s.status === 'signedOut' ? s : { status: 'signedOut' }))
      else if (event === 'SIGNED_IN' || event === 'USER_UPDATED') window.setTimeout(() => alive && load(session), 0)
    })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [load])

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error || !data.session) return false
    await load(data.session)
    return true
  }, [load])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setState({ status: 'signedOut' })
  }, [])

  const reloadProfile = useCallback(async () => {
    const { data } = await supabase.auth.getSession()
    await load(data.session)
  }, [load])

  const value = useMemo(() => ({ state, signIn, signOut, reloadProfile }), [state, signIn, signOut, reloadProfile])
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth(): Ctx {
  const c = useContext(AuthCtx)
  if (!c) throw new Error('useAuth outside provider')
  return c
}

/** Only usable below the auth gate. */
export function useMe(): { profile: Profile; session: Session; isAdmin: boolean } {
  const { state } = useAuth()
  if (state.status !== 'signedIn') throw new Error('useMe outside the signed-in area')
  return { profile: state.profile, session: state.session, isAdmin: state.profile.role === 'admin' }
}
