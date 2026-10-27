import { useMemo, useState } from 'react'
import { LangSwitch } from '../components/Shell'
import { Field, Panel, PageTitle, Spinner } from '../components/ui'
import { useData } from '../ctx/Data'
import { useToast } from '../ctx/Toast'
import type { Material } from '../lib/dbTypes'
import { useI18n } from '../lib/i18n'
import type { TKey } from '../lib/i18n/en'
import { settingsMap } from '../lib/inventoryModel'
import { dbError, supabase } from '../lib/supabase'

const NUMS: { key: string; label: TKey }[] = [
  { key: 'pipe_stock_length', label: 'set.pipeLength' },
  { key: 'projection_standard', label: 'set.projStd' },
  { key: 'projection_seismic', label: 'set.projSeismic' },
  { key: 'screen_default_piezometer', label: 'set.scrPiezo' },
  { key: 'screen_default_permeability', label: 'set.scrPerm' },
  { key: 'screen_default_standpipe', label: 'set.scrStand' },
  { key: 'cutting_allowance', label: 'set.kerf' },
  { key: 'min_offcut_length', label: 'set.minOffcut' },
]
const BOOLS: { key: string; label: TKey }[] = [
  { key: 'cutting_allowance_enabled', label: 'set.kerfEnabled' },
  { key: 'allow_joints', label: 'set.joints' },
  { key: 'allow_user_screen_override', label: 'set.screenOverride' },
  { key: 'users_can_view_transactions', label: 'set.usersTx' },
  { key: 'users_view_all_installations', label: 'set.usersAll' },
]

export function Settings() {
  const { t } = useI18n()
  const { settings, materials, overview, loading, refresh } = useData()
  const toast = useToast()
  const saved = useMemo(() => settingsMap(settings), [settings])
  const [draft, setDraft] = useState<Record<string, string | boolean>>({})
  const [busy, setBusy] = useState(false)

  if (loading) return <Spinner />
  const cur = (k: string): string | boolean => (k in draft ? draft[k] : typeof saved[k] === 'boolean' ? (saved[k] as boolean) : String(saved[k] ?? ''))
  const dirtyKeys = Object.keys(draft).filter((k) => String(draft[k]) !== String(saved[k]))
  const lengthLocked = overview.some((o) => o.category === 'pipe' && Number(o.available) > 0)

  const save = async () => {
    const payload: Record<string, unknown> = {}
    for (const k of dirtyKeys) payload[k] = typeof draft[k] === 'boolean' ? draft[k] : k === 'default_language' ? draft[k] : Number(String(draft[k]).replace(',', '.'))
    setBusy(true)
    const { error } = await supabase.rpc('admin_update_settings', { p: payload })
    setBusy(false)
    if (error) {
      const d = dbError(error)
      return toast.push('err', d.code === 'STOCK_LENGTH_LOCKED' ? t('set.lengthLocked') + ' ' + d.message : d.message)
    }
    toast.push('ok', t('set.saved'))
    setDraft({})
    await refresh()
  }

  return (
    <div className="animate-boot space-y-4">
      <PageTitle sub={t('set.futureOnly')} right={<div className="flex items-center gap-3">{dirtyKeys.length > 0 && <span className="text-xs text-tva-amber">{t('set.dirty')}</span>}<button className="btn btn-solid" disabled={!dirtyKeys.length || busy} onClick={() => void save()}>{t('set.save')}</button></div>}>{t('set.title')}</PageTitle>

      <Panel title={t('set.defaults')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {NUMS.map((n) => (
            <Field key={n.key} label={t(n.label)} hint={n.key === 'pipe_stock_length' && lengthLocked ? t('set.lengthLocked') : undefined}>
              <input className="field num" inputMode="decimal" value={String(cur(n.key))} disabled={n.key === 'pipe_stock_length' && lengthLocked} onChange={(e) => setDraft((d) => ({ ...d, [n.key]: e.target.value }))} />
            </Field>
          ))}
        </div>
      </Panel>

      <Panel title={t('set.policy')}>
        <div className="grid gap-2 sm:grid-cols-2">
          {BOOLS.map((b) => (
            <label key={b.key} className="flex items-center gap-2 border-2 border-tva-brown-dark p-2 text-sm hover:border-tva-brown"><input type="checkbox" checked={cur(b.key) === true} onChange={(e) => setDraft((d) => ({ ...d, [b.key]: e.target.checked }))} /> {t(b.label)}</label>
          ))}
        </div>
      </Panel>

      <Panel title={t('set.language')}>
        <div className="flex flex-wrap items-center gap-4">
          <LangSwitch />
          <Field label={t('set.language') + ' (default)'}><select className="field" value={String(cur('default_language'))} onChange={(e) => setDraft((d) => ({ ...d, default_language: e.target.value }))}><option value="vi">Tiếng Việt</option><option value="en">English</option></select></Field>
        </div>
      </Panel>

      <Panel title={t('set.materials')} bodyClass="overflow-x-auto !p-0">
        <table className="tbl min-w-[800px]">
          <thead><tr><th>{t('common.sku')}</th><th>{t('common.name')} (EN)</th><th>{t('common.name')} (VI)</th><th>{t('mat.diameter')}</th><th className="num">{t('set.lowStock')}</th><th /></tr></thead>
          <tbody>{materials.map((m) => <MaterialRow key={m.id + m.sku + m.name + m.name_vi + m.low_stock_threshold} m={m} onSaved={refresh} />)}</tbody>
        </table>
      </Panel>
    </div>
  )
}

function MaterialRow({ m, onSaved }: { m: Material; onSaved: () => Promise<void> }) {
  const { t } = useI18n()
  const toast = useToast()
  const [sku, setSku] = useState(m.sku)
  const [en, setEn] = useState(m.name)
  const [vi, setVi] = useState(m.name_vi)
  const [low, setLow] = useState(String(m.low_stock_threshold))
  const [busy, setBusy] = useState(false)
  const dirty = sku !== m.sku || en !== m.name || vi !== m.name_vi || Number(low) !== Number(m.low_stock_threshold)
  const save = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('admin_update_material', { p_id: m.id, p_sku: sku, p_name: en, p_name_vi: vi, p_low_stock: Number(low.replace(',', '.')) })
    setBusy(false)
    if (error) return toast.push('err', dbError(error).message)
    toast.push('ok', t('set.materialSaved'))
    await onSaved()
  }
  return (
    <tr>
      <td><input className="field" value={sku} onChange={(e) => setSku(e.target.value)} maxLength={40} aria-label={t('common.sku')} /></td>
      <td><input className="field" value={en} onChange={(e) => setEn(e.target.value)} maxLength={120} /></td>
      <td><input className="field" value={vi} onChange={(e) => setVi(e.target.value)} maxLength={120} /></td>
      <td>{m.diameter}</td>
      <td><input className="field num" inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} /></td>
      <td><button className="btn btn-solid" disabled={!dirty || busy} onClick={() => void save()}>{t('set.saveMaterial')}</button></td>
    </tr>
  )
}
