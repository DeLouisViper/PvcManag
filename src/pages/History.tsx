import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfirmDialog, Empty, Field, Modal, Panel, PageTitle, Spinner, Tag } from '../components/ui'
import { useMe } from '../ctx/Auth'
import { useData } from '../ctx/Data'
import { useToast } from '../ctx/Toast'
import type { CuttingPlanRow, InstallationLocationRow, InstallationRow, UsageRow } from '../lib/dbTypes'
import { INSTALLATION_TYPES, type InstallationType } from '../lib/engine'
import { downloadCsv, downloadPdf } from '../lib/export'
import { fmtDate, fmtDateTime, fmtNum } from '../lib/format'
import { useI18n } from '../lib/i18n'
import type { TKey } from '../lib/i18n/en'
import { matName, typeShort, TYPE_COLORS } from '../lib/labels'
import { dbError, supabase } from '../lib/supabase'

type Row = InstallationRow & { installation_locations: Pick<InstallationLocationRow, 'location_code' | 'installation_type' | 'depth'>[] }
const LIMIT = 500

export function History() {
  const { t, lang } = useI18n()
  const { profiles } = useData()
  const toast = useToast()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [user, setUser] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sort, setSort] = useState<'date' | 'project' | 'depth' | 'type'>('date')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [openId, setOpenId] = useState<string | null>(null)
  const nameOf = useMemo(() => new Map(profiles.map((p) => [p.id, p.full_name || p.email])), [profiles])

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('installations').select('*, installation_locations(location_code, installation_type, depth)').order('created_at', { ascending: false }).limit(LIMIT)
    if (error) {
      toast.push('err', dbError(error).message)
      setRows([])
    } else setRows(data as unknown as Row[])
  }, [toast])
  useEffect(() => { void load() }, [load])

  const shown = useMemo(() => {
    if (!rows) return []
    const s = q.trim().toLowerCase()
    const f = rows.filter((r) => {
      if (s && !(r.project_name ?? '').toLowerCase().includes(s) && !r.ref.toLowerCase().includes(s) && !r.installation_locations.some((l) => l.location_code.toLowerCase().includes(s))) return false
      if (type && !r.installation_locations.some((l) => l.installation_type === type)) return false
      if (user && r.created_by !== user) return false
      if (from && r.install_date < from) return false
      if (to && r.install_date > to) return false
      return true
    })
    const key = (r: Row): string | number => sort === 'date' ? r.created_at : sort === 'project' ? (r.project_name ?? '').toLowerCase() : sort === 'depth' ? Number(r.total_depth) : [...new Set(r.installation_locations.map((l) => l.installation_type))].sort().join(',')
    return f.sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return dir === 'asc' ? c : -c })
  }, [rows, q, type, user, from, to, sort, dir])

  const exportList = () => downloadCsv(`installations-${new Date().toISOString().slice(0, 10)}.csv`, [
    [t('hist.ref'), t('hist.project'), t('common.date'), t('hist.locations'), t('hist.depth'), t('hist.types'), t('common.status'), t('hist.by'), t('hist.at'), t('hist.txRef')],
    ...shown.map((r) => [r.ref, r.project_name ?? '', r.install_date, r.location_count, r.total_depth, [...new Set(r.installation_locations.map((l) => typeShort(t, l.installation_type)))].join(' / '), r.status, nameOf.get(r.created_by) ?? '', r.created_at, r.transaction_ref]),
  ])

  if (rows === null) return <Spinner />
  return (
    <div className="animate-boot space-y-4">
      <PageTitle right={<button className="btn" onClick={exportList} disabled={!shown.length}>{t('hist.exportAll')}</button>}>{t('hist.title')}</PageTitle>
      <Panel>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('common.search')}><input className="field" placeholder={t('hist.search')} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label={t('hist.type')}><select className="field" value={type} onChange={(e) => setType(e.target.value)}><option value="">{t('common.all')}</option>{INSTALLATION_TYPES.map((ty) => <option key={ty} value={ty}>{typeShort(t, ty)}</option>)}</select></Field>
          <Field label={t('hist.user')}><select className="field" value={user} onChange={(e) => setUser(e.target.value)}><option value="">{t('common.all')}</option>{[...new Set(rows.map((r) => r.created_by))].map((id) => <option key={id} value={id}>{nameOf.get(id) ?? id.slice(0, 8)}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-2"><Field label={t('common.from')}><input className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label={t('common.to')}><input className="field" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
          <Field label={t('hist.sort')}><select className="field" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>{(['date', 'project', 'type', 'depth'] as const).map((s) => <option key={s} value={s}>{t(`hist.sort.${s}` as TKey)}</option>)}</select></Field>
          <Field label=" "><select className="field" value={dir} onChange={(e) => setDir(e.target.value as 'asc' | 'desc')}><option value="desc">{t('hist.desc')}</option><option value="asc">{t('hist.asc')}</option></select></Field>
          <div className="flex items-end"><button className="btn btn-ghost" onClick={() => { setQ(''); setType(''); setUser(''); setFrom(''); setTo(''); setSort('date'); setDir('desc') }}>{t('common.reset')}</button></div>
        </div>
      </Panel>

      {shown.length === 0 ? <Empty>{t('hist.empty')}</Empty> : (
        <Panel bodyClass="overflow-x-auto !p-0">
          <table className="tbl min-w-[900px]">
            <thead><tr><th>{t('hist.ref')}</th><th>{t('hist.project')}</th><th>{t('common.date')}</th><th>{t('hist.types')}</th><th className="num">{t('hist.locations')}</th><th className="num">{t('hist.depth')}</th><th>{t('hist.by')}</th><th>{t('common.status')}</th><th /></tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={r.id}>
                <td className="font-bold">{r.ref}</td><td>{r.project_name || <span className="text-tva-brown">-</span>}</td><td className="whitespace-nowrap">{fmtDate(r.install_date, lang)}</td>
                <td>{[...new Set(r.installation_locations.map((l) => l.installation_type))].map((ty) => <span key={ty} className="mr-1 inline-block border-l-4 pl-1 text-xs" style={{ borderColor: TYPE_COLORS[ty as InstallationType] }}>{typeShort(t, ty as InstallationType)}</span>)}</td>
                <td className="num">{r.location_count}</td><td className="num">{fmtNum(Number(r.total_depth), 3, lang)} m</td>
                <td>{nameOf.get(r.created_by) ?? '-'}</td>
                <td><Tag kind={r.status === 'completed' ? 'ok' : 'bad'}>{r.status === 'completed' ? t('hist.completed') : t('hist.reversed')}</Tag></td>
                <td><button className="btn" onClick={() => setOpenId(r.id)}>{t('hist.view')}</button></td>
              </tr>
            ))}</tbody>
          </table>
        </Panel>
      )}
      {rows.length >= LIMIT && <p className="text-xs text-tva-sand">{t('hist.limit', { n: LIMIT })}</p>}
      {openId && <Detail id={openId} nameOf={nameOf} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  )
}

function Detail({ id, nameOf, onClose, onChanged }: { id: string; nameOf: Map<string, string>; onClose: () => void; onChanged: () => Promise<void> }) {
  const { t, lang } = useI18n()
  const { isAdmin } = useMe()
  const { materials, refresh } = useData()
  const toast = useToast()
  const [d, setD] = useState<{ inst: InstallationRow; locs: InstallationLocationRow[]; plan: CuttingPlanRow[]; usage: UsageRow[] } | null>(null)
  const [reverse, setReverse] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const mById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials])
  const mn = (mid: string) => matName(mById.get(mid), lang)

  const load = useCallback(async () => {
    const [i, l, p, u] = await Promise.all([
      supabase.from('installations').select('*').eq('id', id).single(),
      supabase.from('installation_locations').select('*').eq('installation_id', id).order('line_no'),
      supabase.from('installation_cutting_plans').select('*').eq('installation_id', id).order('step_no'),
      supabase.from('installation_material_usage').select('*').eq('installation_id', id),
    ])
    const err = [i, l, p, u].find((x) => x.error)?.error
    if (err) { toast.push('err', dbError(err).message); onClose(); return }
    setD({ inst: i.data as InstallationRow, locs: l.data as InstallationLocationRow[], plan: p.data as CuttingPlanRow[], usage: u.data as UsageRow[] })
  }, [id, toast, onClose])
  useEffect(() => { void load() }, [load])

  if (!d) return <Modal title={t('hist.detail')} onClose={onClose}><Spinner /></Modal>
  const { inst, locs, plan, usage } = d
  const locOf = new Map(locs.map((l) => [l.id, l]))
  const sumBy = (comp: UsageRow['component'], mid: string) => usage.filter((u) => u.component === comp && u.material_id === mid).reduce((s, u) => s + Number(u.quantity), 0)
  const lenBy = (comp: UsageRow['component'], mid: string) => usage.filter((u) => u.component === comp && u.material_id === mid).reduce((s, u) => s + Number(u.length ?? 0), 0)
  const usedMats = [...new Set(usage.map((u) => u.material_id))]
  const m3 = (v: number) => fmtNum(Number(v), 3, lang)
  const settings = (inst.settings_snapshot as { settings?: Record<string, unknown> }).settings ?? {}

  const usageRows = usedMats.map((mid) => {
    const mat = mById.get(mid)
    return [mat?.sku ?? '?', mn(mid), mat?.category === 'pipe' ? `${m3(sumBy('pvc', mid) ? lenBy('pvc', mid) : 0)} m PVC` : mat?.category === 'screen' ? `${m3(lenBy('screen', mid))} m` : '',
      sumBy('full_pipe', mid), sumBy('offcut_consumed', mid) ? `${sumBy('offcut_consumed', mid)} / ${m3(lenBy('offcut_consumed', mid))} m` : '-', sumBy('offcut_generated', mid) ? `${sumBy('offcut_generated', mid)} / ${m3(lenBy('offcut_generated', mid))} m` : '-',
      sumBy('top_cap', mid), sumBy('bottom_cap', mid)] as (string | number)[]
  })
  const usageHead = [t('common.sku'), t('inv.material'), t('hist.pvcConsumed'), t('hist.fullUsed'), t('hist.consumedOff'), t('hist.returned'), t('calc.r.topCaps'), t('calc.r.bottomCaps')]
  const locHead = [t('calc.location'), t('common.type'), t('calc.depth'), t('calc.projection'), t('calc.screen'), t('calc.totalLength'), t('calc.pvcLength')]
  const locBody = locs.map((l) => [l.location_code, typeShort(t, l.installation_type), l.depth, l.projection, l.screen_length, l.total_length, l.pvc_length])
  const planHead = [t('calc.r.step'), t('inv.material'), t('calc.r.source'), t('calc.r.source') + ' (m)', t('calc.r.cut') + ' (m)', t('calc.r.useFor'), t('calc.r.leftover') + ' (m)', t('calc.r.scrap').split(' (')[0] + ' (m)']
  const planBody = plan.map((p) => [p.step_no, mn(p.material_id), t(`calc.src.${p.source}` as TKey), p.source_length, p.cut_length, locOf.get(p.location_id)?.location_code ?? '', p.leftover_length, Number(p.scrap_length) + Number(p.kerf_length)])
  const meta = [`${t('hist.ref')}: ${inst.ref}`, `${t('hist.project')}: ${inst.project_name ?? '-'}`, `${t('common.date')}: ${fmtDate(inst.install_date, lang)}`, `${t('hist.by')}: ${nameOf.get(inst.created_by) ?? '-'} - ${fmtDateTime(inst.created_at, lang)}`, `${t('hist.txRef')}: ${inst.transaction_ref}`, `${t('common.status')}: ${inst.status}`]

  const csv = () => downloadCsv(`${inst.ref}.csv`, [
    meta, [], [t('hist.snapshot')], ...Object.entries(settings).map(([k, v]) => [k, String(v)]), [], [t('calc.locations')], locHead, ...locBody, [], [t('calc.r.cuttingPlan')], planHead, ...planBody, [], [t('hist.usage')], usageHead, ...usageRows,
  ])
  const pdf = async () => {
    try {
      await downloadPdf(`${inst.ref}.pdf`, `HAIC - ${t('hist.detail')} ${inst.ref}`, meta, [
        { title: t('calc.locations'), head: locHead, body: locBody }, { title: t('calc.r.cuttingPlan'), head: planHead, body: planBody }, { title: t('hist.usage'), head: usageHead, body: usageRows },
        { title: t('hist.snapshot'), head: ['key', 'value'], body: Object.entries(settings).map(([k, v]) => [k, String(v)]) },
      ])
    } catch (e) { toast.push('err', String(e)) }
  }

  const doReverse = async () => {
    setBusy(true)
    const { data, error } = await supabase.rpc('admin_reverse_installation', { p_installation: inst.id, p_reason: reason.trim() })
    setBusy(false)
    if (error) return toast.push('err', dbError(error).message)
    toast.push('ok', t('hist.reverseDone', { ref: (data as { transaction_ref: string }).transaction_ref }))
    setReverse(false)
    await Promise.all([refresh(), onChanged(), load()])
  }

  return (
    <Modal title={`${t('hist.detail')} ${inst.ref}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm">
            <div><b>{inst.project_name || '-'}</b> - {fmtDate(inst.install_date, lang)}</div>
            <div className="text-xs text-tva-sand">{nameOf.get(inst.created_by) ?? '-'} - {fmtDateTime(inst.created_at, lang)} - {t('hist.txRef')}: {inst.transaction_ref}</div>
            {inst.notes && <div className="text-xs text-tva-sand">{inst.notes}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tag kind={inst.status === 'completed' ? 'ok' : 'bad'}>{inst.status === 'completed' ? t('hist.completed') : t('hist.reversed')}</Tag>
            <button className="btn" onClick={csv}>{t('hist.exportCsv')}</button>
            <button className="btn" onClick={() => void pdf()}>{t('hist.exportPdf')}</button>
            {isAdmin && inst.status === 'completed' && <button className="btn btn-danger" onClick={() => setReverse(true)}>{t('hist.reverse')}</button>}
          </div>
        </div>
        {inst.status === 'reversed' && <p className="border-2 border-tva-red p-2 text-xs text-tva-red">{t('hist.reversedInfo', { date: fmtDateTime(inst.reversed_at, lang), reason: inst.reversal_reason ?? '' })}</p>}

        <Table title={t('calc.locations')} head={locHead} body={locBody.map((r) => r.map((c, i) => (i >= 2 ? m3(Number(c)) : c)))} />
        <Table title={t('calc.r.cuttingPlan')} head={planHead} body={planBody.map((r) => r.map((c, i) => (i === 3 || i === 4 || i === 6 || i === 7 ? m3(Number(c)) : c)))} />
        <Table title={t('hist.usage')} head={usageHead} body={usageRows} />
        <details className="border-2 border-tva-brown p-2 text-xs">
          <summary className="cursor-pointer font-bold uppercase tracking-widest text-tva-sand">{t('hist.snapshot')}</summary>
          <div className="mt-2 grid gap-x-6 sm:grid-cols-2">{Object.entries(settings).map(([k, v]) => <div key={k} className="flex justify-between border-b border-tva-brown-dark py-0.5"><span className="text-tva-sand">{k}</span><span>{String(v)}</span></div>)}</div>
        </details>
      </div>
      {reverse && (
        <ConfirmDialog title={t('hist.reverse')} body={t('hist.reverseHint')} confirmLabel={t('common.confirm')} danger busy={busy || reason.trim().length < 3} onConfirm={() => void doReverse()} onCancel={() => setReverse(false)}>
          <Field label={t('common.reason')}><input className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus /></Field>
        </ConfirmDialog>
      )}
    </Modal>
  )
}

function Table({ title, head, body }: { title: string; head: string[]; body: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <h3 className="label">{title}</h3>
      <table className="tbl"><thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
    </div>
  )
}
