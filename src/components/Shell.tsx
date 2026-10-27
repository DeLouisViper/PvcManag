import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth, useMe } from '../ctx/Auth'
import { useData } from '../ctx/Data'
import { useI18n } from '../lib/i18n'
import type { TKey } from '../lib/i18n/en'
import { supabase } from '../lib/supabase'
import { Tag } from './ui'

const NAV: { to: string; key: TKey; admin?: boolean; icon: string }[] = [
  { to: '/', key: 'nav.dashboard', icon: '01' },
  { to: '/calculator', key: 'nav.calculator', icon: '02' },
  { to: '/inventory', key: 'nav.inventory', icon: '03' },
  { to: '/history', key: 'nav.history', icon: '04' },
  { to: '/transactions', key: 'nav.transactions', icon: '05' },
  { to: '/users', key: 'nav.users', admin: true, icon: '06' },
  { to: '/settings', key: 'nav.settings', admin: true, icon: '07' },
]

export function LangSwitch() {
  const { lang, setLang, t } = useI18n()
  return (
    <div className="flex items-center gap-1 text-[11px]" role="group" aria-label={t('shell.lang')}>
      {(['vi', 'en'] as const).map((l) => (
        <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} className={`border-2 px-2 py-0.5 font-bold uppercase ${lang === l ? 'border-tva-orange bg-tva-orange text-tva-dark' : 'border-tva-brown text-tva-sand hover:border-tva-orange'}`}>{l}</button>
      ))}
    </div>
  )
}

function Clock() {
  const { lang } = useI18n()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30000)
    return () => window.clearInterval(id)
  }, [])
  return <>{now.toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })} {now.toLocaleTimeString(lang === 'vi' ? 'vi-VN' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</>
}

export function Shell() {
  const { t, lang } = useI18n()
  const { profile, isAdmin } = useMe()
  const { signOut } = useAuth()
  const { online, lowStock, refresh } = useData()
  const [open, setOpen] = useState(false)

  // keep the user's language preference in sync with the profile (stored, but UI changes stay instant)
  useEffect(() => {
    if (profile.language !== lang) void supabase.rpc('set_my_language', { p_lang: lang })
  }, [lang, profile.language])

  const items = NAV.filter((n) => !n.admin || isAdmin)
  const nav = (
    <nav className="flex flex-col gap-1" aria-label="main">
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setOpen(false)}
          className={({ isActive }) => `flex items-center gap-3 border-2 px-3 py-2 text-xs font-bold uppercase tracking-widest transition-colors ${isActive ? 'border-tva-orange bg-tva-orange text-tva-dark shadow-tva-glow' : 'border-tva-brown-dark text-tva-cream hover:border-tva-orange hover:text-tva-orange'}`}>
          <span className="opacity-70">{n.icon}</span>
          <span className="flex-1">{t(n.key)}</span>
          {n.admin && <span className="border border-current px-1 text-[9px]">{t('nav.admin')}</span>}
        </NavLink>
      ))}
    </nav>
  )

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      <header className="flex items-center justify-between border-b-4 border-tva-brown bg-tva-panel px-3 py-2 lg:hidden">
        <div className="glow-text font-bold tracking-widest text-tva-orange">{t('app.name')}</div>
        <button className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="sidebar">{t('shell.menu')}</button>
      </header>

      <aside id="sidebar" className={`${open ? 'block' : 'hidden'} w-full shrink-0 border-b-4 border-tva-brown bg-tva-panel lg:sticky lg:top-0 lg:block lg:h-screen lg:w-72 lg:overflow-y-auto lg:border-b-0 lg:border-r-4`}>
        <div className="hidden border-b-4 border-tva-brown bg-tva-brown-dark p-4 lg:block">
          <div className="glow-text text-lg font-bold tracking-widest text-tva-orange">{t('app.name')}</div>
          <div className="mt-1 text-[10px] uppercase tracking-widest text-tva-sand">{t('app.sub')}</div>
        </div>
        <div className="space-y-4 p-3">
          <div className="border-2 border-tva-brown p-3 text-xs">
            <div className="text-[10px] uppercase tracking-widest text-tva-sand">{t('shell.user')}</div>
            <div className="mt-1 break-words text-sm font-bold text-tva-cream">{profile.full_name || profile.email}</div>
            <div className="mt-1"><Tag kind={isAdmin ? 'warn' : 'mute'}>{isAdmin ? t('shell.role.admin') : t('shell.role.user')}</Tag></div>
            <div className="mt-2 text-[11px] text-tva-sand"><span className="uppercase tracking-widest">{t('shell.date')}:</span> <Clock /></div>
          </div>
          {nav}
          <div className="space-y-1 border-2 border-tva-brown p-3 text-[11px]">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-tva-sand">{t('shell.status')}</div>
            <div className="flex items-center justify-between"><span>{t('shell.db')}</span><span className={online ? 'text-tva-teal' : 'text-tva-red'}><span className={online ? 'animate-blink' : ''}>&#9679;</span> {online ? t('shell.online') : t('shell.offline')}</span></div>
            <div className="flex items-center justify-between"><span>{t('shell.stock')}</span>{lowStock.length === 0 ? <span className="text-tva-teal">&#9679; {t('shell.stock.ok')}</span> : <span className="text-tva-amber"><span className="animate-blink">&#9679;</span> {t('shell.stock.low')} ({lowStock.length})</span>}</div>
            <button className="btn btn-ghost mt-2 w-full" onClick={() => void refresh()}>{t('common.refresh')}</button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <LangSwitch />
            <button className="btn btn-danger" onClick={() => void signOut()}>{t('shell.signout')}</button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-3 sm:p-6">
        <Outlet />
      </main>
    </div>
  )
}
