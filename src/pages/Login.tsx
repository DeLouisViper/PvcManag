import { useState, type FormEvent } from 'react'
import { LangSwitch } from '../components/Shell'
import { Field } from '../components/ui'
import { useAuth } from '../ctx/Auth'
import { useI18n } from '../lib/i18n'
import { isConfigured } from '../lib/supabase'

export function Login() {
  const { t } = useI18n()
  const { state, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setFailed(false)
    const ok = await signIn(email, password)
    setFailed(!ok)
    setBusy(false)
  }
  const stateError = state.status === 'signedOut' ? state.error : undefined

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="panel w-full max-w-md bg-tva-panel shadow-tva-glow">
        <header className="border-b-4 border-tva-brown bg-tva-brown-dark p-4">
          <div className="glow-text text-xl font-bold tracking-widest text-tva-orange">{t('app.name')}</div>
          <div className="mt-1 text-[10px] uppercase tracking-widest text-tva-sand">{t('app.sub')}</div>
        </header>
        <form onSubmit={submit} className="space-y-4 p-5">
          <h1 className="text-sm font-bold uppercase tracking-widest text-tva-amber"><span className="animate-blink">&#9608;</span> {t('login.title')}</h1>
          <p className="text-xs text-tva-sand">{t('login.subtitle')}</p>
          {!isConfigured && <p role="alert" className="border-2 border-tva-red p-2 text-xs text-tva-red">{t('login.notConfigured')}</p>}
          <Field label={t('common.email')}><input className="field" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label={t('common.password')}><input className="field" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {failed && <p role="alert" className="border-2 border-tva-red p-2 text-xs text-tva-red">{t('login.failed')}</p>}
          {stateError === 'disabled' && !failed && <p role="alert" className="border-2 border-tva-red p-2 text-xs text-tva-red">{t('login.disabled')}</p>}
          {stateError === 'noProfile' && !failed && <p role="alert" className="border-2 border-tva-red p-2 text-xs text-tva-red">{t('login.noProfile')}</p>}
          <div className="flex items-center justify-between gap-3">
            <LangSwitch />
            <button className="btn btn-solid" disabled={busy || !isConfigured}>{busy ? t('common.loading') : t('login.submit')}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
