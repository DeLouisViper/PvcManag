import { useState, type FormEvent } from 'react'
import { Field } from '../components/ui'
import { useAuth } from '../ctx/Auth'
import { useToast } from '../ctx/Toast'
import { useI18n } from '../lib/i18n'
import { supabase } from '../lib/supabase'

export function ChangePassword() {
  const { t } = useI18n()
  const { reloadProfile, signOut } = useAuth()
  const toast = useToast()
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (a.length < 8) return setErr(t('pwd.short'))
    if (a !== b) return setErr(t('pwd.mismatch'))
    setBusy(true)
    setErr(null)
    const up = await supabase.auth.updateUser({ password: a })
    if (up.error) {
      setErr(up.error.message)
      setBusy(false)
      return
    }
    await supabase.rpc('mark_password_changed')
    toast.push('ok', t('pwd.changed'))
    await reloadProfile()
    setBusy(false)
  }
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="panel w-full max-w-md space-y-4 bg-tva-panel p-5 shadow-tva-glow">
        <h1 className="text-sm font-bold uppercase tracking-widest text-tva-amber">{t('pwd.title')}</h1>
        <p className="text-xs text-tva-sand">{t('pwd.hint')}</p>
        <Field label={t('pwd.new')}><input className="field" type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} required /></Field>
        <Field label={t('pwd.confirm')}><input className="field" type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} required /></Field>
        {err && <p role="alert" className="border-2 border-tva-red p-2 text-xs text-tva-red">{err}</p>}
        <div className="flex justify-between">
          <button type="button" className="btn btn-ghost" onClick={() => void signOut()}>{t('shell.signout')}</button>
          <button className="btn btn-solid" disabled={busy}>{t('common.save')}</button>
        </div>
      </form>
    </div>
  )
}
