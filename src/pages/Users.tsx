import { useState, type FormEvent } from 'react'
import { ConfirmDialog, Field, Modal, Panel, PageTitle, Tag } from '../components/ui'
import { useMe } from '../ctx/Auth'
import { useData } from '../ctx/Data'
import { useToast } from '../ctx/Toast'
import type { Profile, Role } from '../lib/dbTypes'
import { fmtDateTime } from '../lib/format'
import { useI18n } from '../lib/i18n'
import { dbError, supabase } from '../lib/supabase'

function genPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const a = new Uint32Array(12)
  crypto.getRandomValues(a)
  return Array.from(a, (n) => chars[n % chars.length]).join('') + '#7'
}

async function callFn(body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string; unreachable?: boolean }> {
  const { data, error } = await supabase.functions.invoke('admin-users', { body })
  if (error) {
    let msg = error.message
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      try { msg = ((await ctx.json()) as { error?: string }).error ?? msg } catch { /* keep message */ }
    }
    return { ok: false, error: msg, unreachable: /Failed to send|fetch|404|not found/i.test(msg) }
  }
  return (data as { ok?: boolean })?.ok ? { ok: true } : { ok: false, error: (data as { error?: string })?.error ?? 'error' }
}

export function Users() {
  const { t, lang } = useI18n()
  const { profile: me } = useMe()
  const { profiles, refresh } = useData()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [edit, setEdit] = useState<Profile | null>(null)
  const [reset, setReset] = useState<Profile | null>(null)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)

  const fnError = (r: { error: string; unreachable?: boolean }) => toast.push('err', r.unreachable ? t('users.fnMissing') : r.error)

  return (
    <div className="animate-boot space-y-4">
      <PageTitle sub={t('users.createHint')} right={<button className="btn btn-solid" onClick={() => setCreating(true)}>+ {t('users.create')}</button>}>{t('users.title')}</PageTitle>
      <p className="border-2 border-tva-brown p-2 text-xs text-tva-sand">{t('users.deployNote')}</p>
      <Panel bodyClass="overflow-x-auto !p-0">
        <table className="tbl min-w-[720px]">
          <thead><tr><th>{t('common.fullName')}</th><th>{t('common.email')}</th><th>{t('common.role')}</th><th>{t('common.status')}</th><th>{t('hist.at')}</th><th /></tr></thead>
          <tbody>{profiles.map((p) => (
            <tr key={p.id}>
              <td className="font-bold">{p.full_name} {p.id === me.id && <span className="text-tva-sand">({t('users.self')})</span>}</td><td>{p.email}</td>
              <td><Tag kind={p.role === 'admin' ? 'warn' : 'mute'}>{p.role === 'admin' ? t('shell.role.admin') : t('shell.role.user')}</Tag></td>
              <td><Tag kind={p.active ? 'ok' : 'bad'}>{p.active ? t('common.active') : t('common.disabled')}</Tag></td>
              <td className="whitespace-nowrap text-xs">{fmtDateTime(p.created_at, lang)}</td>
              <td className="whitespace-nowrap"><button className="btn mr-1" onClick={() => setEdit(p)}>{t('users.edit')}</button><button className="btn btn-ghost" onClick={() => { setReset(p); setPw(genPassword()) }}>{t('users.resetPassword')}</button></td>
            </tr>
          ))}</tbody>
        </table>
      </Panel>

      {creating && <CreateUser onClose={() => setCreating(false)} onDone={async () => { setCreating(false); await refresh() }} fnError={fnError} />}

      {edit && <EditUser p={edit} self={edit.id === me.id} onClose={() => setEdit(null)} onDone={async () => { setEdit(null); await refresh() }} />}

      {reset && (
        <ConfirmDialog title={`${t('users.resetPassword')} - ${reset.email}`} confirmLabel={t('common.confirm')} busy={busy || pw.length < 8} onCancel={() => setReset(null)}
          onConfirm={async () => {
            setBusy(true)
            const r = await callFn({ action: 'reset_password', user_id: reset.id, password: pw })
            setBusy(false)
            if (!r.ok) return fnError(r)
            toast.push('ok', t('users.resetDone') + '  ' + pw)
            setReset(null)
          }}>
          <Field label={t('users.tempPassword')}><div className="flex gap-2"><input className="field" value={pw} onChange={(e) => setPw(e.target.value)} /><button className="btn" onClick={() => setPw(genPassword())}>{t('users.generate')}</button></div></Field>
        </ConfirmDialog>
      )}
    </div>
  )
}

function CreateUser({ onClose, onDone, fnError }: { onClose: () => void; onDone: () => Promise<void>; fnError: (r: { error: string; unreachable?: boolean }) => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [pw, setPw] = useState(genPassword())
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const r = await callFn({ action: 'create', email, full_name: name, role, password: pw })
    setBusy(false)
    if (!r.ok) return fnError(r)
    toast.push('ok', `${t('users.created')}  ${email} / ${pw}`)
    await onDone()
  }
  return (
    <Modal title={t('users.create')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('common.fullName')}><input className="field" required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label={t('common.email')}><input className="field" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t('users.role')}><select className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}><option value="user">{t('shell.role.user')}</option><option value="admin">{t('shell.role.admin')}</option></select></Field>
        <Field label={t('users.tempPassword')}><div className="flex gap-2"><input className="field" required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} /><button type="button" className="btn" onClick={() => setPw(genPassword())}>{t('users.generate')}</button></div></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-solid" disabled={busy}>{t('users.create')}</button></div>
      </form>
    </Modal>
  )
}

function EditUser({ p, self, onClose, onDone }: { p: Profile; self: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useI18n()
  const toast = useToast()
  const [name, setName] = useState(p.full_name)
  const [role, setRole] = useState<Role>(p.role)
  const [active, setActive] = useState(p.active)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const { error } = await supabase.rpc('admin_update_profile', { p_user: p.id, p_full_name: name, p_role: role, p_active: active })
    setBusy(false)
    if (error) {
      const d = dbError(error)
      return toast.push('err', d.code === 'LAST_ADMIN' ? t('users.lastAdmin') : d.message)
    }
    toast.push('ok', t('users.updated'))
    await onDone()
  }
  return (
    <Modal title={`${t('users.edit')} - ${p.email}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('common.fullName')}><input className="field" required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label={t('users.role')}><select className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}><option value="user">{t('shell.role.user')}</option><option value="admin">{t('shell.role.admin')}</option></select></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('users.active')}</label>
        {self && <p className="text-[11px] text-tva-sand">{t('users.lastAdmin')}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-solid" disabled={busy}>{t('common.save')}</button></div>
      </form>
    </Modal>
  )
}
