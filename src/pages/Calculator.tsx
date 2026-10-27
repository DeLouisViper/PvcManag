import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmDialog, Empty, Field, Modal, Panel, PageTitle, Stat, Tag } from '../components/ui'
import { useMe } from '../ctx/Auth'
import { useData } from '../ctx/Data'
import { useToast } from '../ctx/Toast'
import type { SaveResult, Shortage } from '../lib/dbTypes'
import {
  INSTALLATION_TYPES, calculate, formatMm, parseMetres, toRpcPlan,
  type CalculationResult, type InstallationType, type LocationInput, type StockLine, type ValidationIssue,
} from '../lib/engine'
import { fmtNum, todayIso } from '../lib/format'
import { useI18n } from '../lib/i18n'
import type { TKey } from '../lib/i18n/en'
import { bucketLabel, issueText, matName, typeFull, typeShort, TYPE_COLORS } from '../lib/labels'
import { buildEngineConfig, buildInventoryInput, settingsMap } from '../lib/inventoryModel'
import { dbError, supabase } from '../lib/supabase'

interface Row { id: number; type: InstallationType; code: string; depth: string; screen: string }
interface Calc { res: CalculationResult; inputsKey: string; invKey: string; requestId: string }
interface Saved { ref: string; tx: string; installationId: string; res: CalculationResult }

let rowSeq = 1
const newRow = (type: InstallationType, n: number): Row => ({ id: rowSeq++, type, code: `BH-${String(n).padStart(2, '0')}`, depth: '', screen: '' })

export function Calculator() {
  const { t, lang } = useI18n()
  const { profile, isAdmin } = useMe()
  const toast = useToast()
  const { materials, itypes, settings, balances, offcuts, refresh } = useData()

  const [project, setProject] = useState('')
  const [date, setDate] = useState(todayIso())
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState<Row[]>(() => [newRow('piezometer', 1)])
  const [calc, setCalc] = useState<Calc | null>(null)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [saved, setSaved] = useState<Saved | null>(null)
  const [short, setShort] = useState<Shortage[] | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [recalcPending, setRecalcPending] = useState(false)
  const savingRef = useRef(false)

  const smap = useMemo(() => settingsMap(settings), [settings])
  const cfg = useMemo(() => buildEngineConfig(itypes, smap), [itypes, smap])
  const inv = useMemo(() => buildInventoryInput(materials, balances, offcuts), [materials, balances, offcuts])
  const invKey = useMemo(() => JSON.stringify([balances.map((b) => [b.material_id, b.bucket, b.quantity]), offcuts.map((o) => [o.id, o.length])]), [balances, offcuts])
  const mById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials])
  const mname = useCallback((id: string) => matName(mById.get(id), lang), [mById, lang])
  const canOverride = isAdmin || smap['allow_user_screen_override'] !== false

  const inputsKey = useMemo(() => JSON.stringify([project, date, rows.map((r) => [r.type, r.code, r.depth, r.screen])]), [project, date, rows])
  const stale = calc !== null && (calc.inputsKey !== inputsKey || calc.invKey !== invKey)

  const locInputs = useCallback((): LocationInput[] => rows.map((r) => ({ type: r.type, code: r.code, depthM: r.depth, screenM: r.screen.trim() === '' ? null : r.screen })), [rows])

  const setRow = (id: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    setIssues([])
  }
  const addRow = (type: InstallationType) => setRows((rs) => [...rs, newRow(type, rs.filter((r) => r.type === type).length + 1)])
  const removeRow = (id: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : rs))

  const runCalc = useCallback(() => {
    const res = calculate(locInputs(), cfg, inv)
    if (!res.ok) {
      setIssues(res.issues)
      setCalc(null)
      toast.push('err', t('calc.fixErrors'))
      return
    }
    setIssues([])
    setSaved(null)
    setCalc({ res, inputsKey, invKey, requestId: crypto.randomUUID() })
    if (res.shortages.length) toast.push('warn', t('calc.insufficient'))
  }, [locInputs, cfg, inv, inputsKey, invKey, toast, t])

  // after a "stale plan" answer from the database, recalculate as soon as the fresh inventory arrived
  useEffect(() => {
    if (recalcPending) {
      setRecalcPending(false)
      runCalc()
    }
  }, [recalcPending, runCalc])

  const reset = () => {
    setRows([newRow('piezometer', 1)])
    setProject('')
    setNotes('')
    setDate(todayIso())
    setCalc(null)
    setIssues([])
    setSaved(null)
  }

  const doSave = async () => {
    if (!calc || savingRef.current) return // synchronous guard: a double click can never submit twice
    savingRef.current = true
    setSaving(true)
    setConfirm(false)
    try {
      const payload = {
        client_request_id: calc.requestId,
        project_name: project.trim() || null,
        install_date: date,
        notes: notes.trim() || null,
        locations: rows.map((r) => ({ type: r.type, code: r.code.trim(), depth: Number(r.depth.replace(',', '.')), screen_length: r.screen.trim() === '' ? null : Number(r.screen.replace(',', '.')) })),
        plan: toRpcPlan(calc.res),
      }
      const { data, error } = await supabase.rpc('save_installation', { p: payload })
      if (error) throw error
      const r = data as SaveResult
      if (r.ok) {
        toast.push('ok', r.duplicate ? t('calc.duplicateOk', { ref: r.ref }) : t('calc.savedOk', { ref: r.ref, tx: r.transaction_ref }))
        setSaved({ ref: r.ref, tx: r.transaction_ref, installationId: r.installation_id, res: calc.res })
        setCalc(null)
        setRows([newRow('piezometer', 1)])
        setProject('')
        setNotes('')
        await refresh()
      } else if (r.error === 'INSUFFICIENT_STOCK') {
        setShort(r.shortages)
        toast.push('err', t('calc.insufficient'))
        await refresh()
      } else {
        toast.push('warn', t('calc.stalePlan'))
        await refresh()
        setRecalcPending(true)
      }
    } catch (e) {
      const d = dbError(e)
      toast.push('err', /fetch|network|Failed/i.test(d.message) ? t('err.network') : d.message)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  // ---- live per-row preview (display only; the authoritative numbers come from Calculate and the database)
  const dupSet = useMemo(() => {
    const c = new Map<string, number>()
    rows.forEach((r) => { const k = r.code.trim().toLowerCase(); if (k) c.set(k, (c.get(k) ?? 0) + 1) })
    return new Set([...c].filter(([, n]) => n > 1).map(([k]) => k))
  }, [rows])

  const rowPreview = (r: Row) => {
    const tc = cfg.types[r.type]
    if (!tc) return null
    const d = parseMetres(r.depth)
    const s = r.screen.trim() === '' ? { ok: true as const, mm: tc.defaultScreenMm } : parseMetres(r.screen)
    const screenMm = tc.screenKey === null ? 0 : s.ok ? s.mm : tc.defaultScreenMm
    if (!d.ok || d.mm <= 0) return { projection: tc.projectionMm, screenMm, total: null as number | null, pvc: null as number | null }
    const total = d.mm + tc.projectionMm
    return { projection: tc.projectionMm, screenMm, total, pvc: Math.max(0, total - screenMm) }
  }

  const rowIssues = (i: number, f: string) => issues.filter((x) => x.rowIndex === i && x.field === f).map((x) => issueText(t, x.code, x.params)).join(' ')
  const generalIssues = issues.filter((x) => x.rowIndex === null)
  const res = calc?.res

  return (
    <div className="animate-boot space-y-4">
      <PageTitle sub={t('calc.formula')}>{t('calc.title')}</PageTitle>

      {saved && (
        <Panel title={`${t('calc.saved.title')} - ${saved.ref}`} className="border-tva-teal shadow-tva-glow-teal" right={<Tag kind="ok">{t('calc.actualSaved')}</Tag>}>
          <p className="mb-2 text-sm">{t('calc.savedOk', { ref: saved.ref, tx: saved.tx })}</p>
          <Results res={saved.res} mname={mname} t={t} lang={lang} actual />
          <div className="mt-3 flex gap-2">
            <button className="btn btn-solid" onClick={() => setSaved(null)}>{t('calc.saved.new')}</button>
            <Link className="btn" to="/history">{t('calc.saved.view')}</Link>
          </div>
        </Panel>
      )}

      <Panel title={t('calc.project')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={<>{t('calc.projectName')} <span className="normal-case text-tva-brown">({t('common.optional')})</span></>}><input className="field" maxLength={200} value={project} onChange={(e) => setProject(e.target.value)} /></Field>
          <Field label={t('calc.installDate')}><input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
          <Field label={<>{t('common.notes')} <span className="normal-case text-tva-brown">({t('common.optional')})</span></>}><input className="field" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
      </Panel>

      <Panel title={t('calc.types')}>
        <div className="flex flex-wrap gap-2">
          {INSTALLATION_TYPES.map((ty) => (
            <button key={ty} className="btn" style={{ borderColor: TYPE_COLORS[ty], color: TYPE_COLORS[ty] }} onClick={() => addRow(ty)}>+ {typeFull(t, ty)}</button>
          ))}
        </div>
        {!canOverride && <p className="mt-2 text-[11px] text-tva-sand">{t('calc.screenLocked')}</p>}
      </Panel>

      <Panel title={t('calc.locations')} right={<button className="btn btn-solid" onClick={() => addRow(rows[rows.length - 1]?.type ?? 'piezometer')}>+ {t('calc.addLocation')}</button>} bodyClass="overflow-x-auto !p-0">
        {generalIssues.map((g, i) => <p key={i} role="alert" className="m-3 border-2 border-tva-red p-2 text-xs text-tva-red">{issueText(t, g.code, g.params)}</p>)}
        <table className="tbl min-w-[860px]">
          <thead><tr><th>{t('common.type')}</th><th>{t('calc.location')}</th><th>{t('calc.depth')}</th><th>{t('calc.screen')}</th><th className="num">{t('calc.projection')}</th><th className="num">{t('calc.totalLength')}</th><th className="num">{t('calc.pvcLength')}</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const p = rowPreview(r)
              const tc = cfg.types[r.type]
              const noScreen = tc?.screenKey === null
              const codeDup = r.code.trim() !== '' && dupSet.has(r.code.trim().toLowerCase())
              const eCode = rowIssues(i, 'code') || (codeDup ? t('err.CODE_DUPLICATE', { code: r.code.trim() }) : '')
              const eDepth = rowIssues(i, 'depth')
              const eScreen = rowIssues(i, 'screen')
              return (
                <tr key={r.id}>
                  <td>
                    <select className="field" value={r.type} onChange={(e) => setRow(r.id, { type: e.target.value as InstallationType, screen: '' })} aria-label={t('common.type')} style={{ borderLeft: `6px solid ${TYPE_COLORS[r.type]}` }}>
                      {INSTALLATION_TYPES.map((ty) => <option key={ty} value={ty}>{typeFull(t, ty)}</option>)}
                    </select>
                  </td>
                  <td><input className={`field ${eCode ? 'field-err' : ''}`} value={r.code} maxLength={60} onChange={(e) => setRow(r.id, { code: e.target.value })} aria-label={t('calc.location')} aria-invalid={!!eCode} />{eCode && <div className="mt-0.5 text-[11px] text-tva-red">{eCode}</div>}</td>
                  <td><input className={`field num ${eDepth ? 'field-err' : ''}`} inputMode="decimal" placeholder="0.0" value={r.depth} onChange={(e) => setRow(r.id, { depth: e.target.value })} aria-label={t('calc.depth')} aria-invalid={!!eDepth} />{eDepth && <div className="mt-0.5 text-[11px] text-tva-red">{eDepth}</div>}</td>
                  <td>
                    <input className={`field num ${eScreen ? 'field-err' : ''}`} inputMode="decimal" disabled={noScreen || !canOverride} value={noScreen ? '' : r.screen} placeholder={noScreen ? t('calc.noScreen') : t('calc.screenDefault', { value: formatMm(tc?.defaultScreenMm ?? 0) })} onChange={(e) => setRow(r.id, { screen: e.target.value })} aria-label={t('calc.screen')} aria-invalid={!!eScreen} />
                    {eScreen && <div className="mt-0.5 text-[11px] text-tva-red">{eScreen}</div>}
                  </td>
                  <td className="num text-tva-sand">{p ? formatMm(p.projection) : '-'}</td>
                  <td className="num font-bold">{p?.total != null ? formatMm(p.total) : '-'}</td>
                  <td className="num font-bold text-tva-orange">{p?.pvc != null ? formatMm(p.pvc) : '-'}</td>
                  <td><button className="btn btn-danger" onClick={() => removeRow(r.id)} disabled={rows.length === 1} aria-label={t('calc.removeLocation')}>x</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-2 border-t-2 border-tva-brown p-3">
          <button className="btn btn-solid" onClick={runCalc}>{t('calc.calculate')}</button>
          <button className="btn btn-ghost" onClick={reset}>{t('calc.reset')}</button>
          <button className="btn btn-solid ml-auto" disabled={!calc || stale || !res?.canSave || saving} onClick={() => setConfirm(true)}>{saving ? t('calc.saving') : t('calc.save')}</button>
        </div>
      </Panel>

      {!res && !saved && <Empty>{t('calc.resultsHint')}</Empty>}
      {res && (
        <Panel title={t('calc.r.requirements')} right={<Tag kind="warn">{t('calc.preview')}</Tag>} className={stale ? 'opacity-60' : ''}>
          {stale && <p role="alert" className="mb-3 border-2 border-tva-amber p-2 text-xs text-tva-amber">{t('calc.stale')}</p>}
          <Results res={res} mname={mname} t={t} lang={lang} />
          {!res.canSave && <p className="mt-3 text-xs text-tva-sand">{t('calc.permissionNote')}</p>}
        </Panel>
      )}

      {confirm && (
        <ConfirmDialog title={t('calc.save')} body={t('calc.confirmSave')} confirmLabel={t('common.confirm')} onConfirm={() => void doSave()} onCancel={() => setConfirm(false)}>
          <p className="text-xs text-tva-sand">{profile.full_name || profile.email} - {rows.length} {t('hist.locations').toLowerCase()}</p>
        </ConfirmDialog>
      )}

      {short && (
        <Modal title={<span className="text-tva-red">{t('calc.insufficient')}</span>} onClose={() => setShort(null)}>
          <p className="mb-3 text-sm">{t('calc.insufficientHint')}</p>
          <table className="tbl">
            <thead><tr><th>{t('inv.material')}</th><th className="num">{t('calc.required')}</th><th className="num">{t('calc.available')}</th><th className="num">{t('calc.missing')}</th></tr></thead>
            <tbody>{short.map((s) => (
              <tr key={s.material_id + s.bucket}><td>{s.sku} <span className="text-tva-sand">({bucketLabel(t, s.bucket)})</span></td><td className="num">{fmtNum(Number(s.required), 3, lang)} {s.unit === 'm' ? 'm' : ''}</td><td className="num">{fmtNum(Number(s.available), 3, lang)}</td><td className="num font-bold text-tva-red">{fmtNum(Number(s.missing), 3, lang)}</td></tr>
            ))}</tbody>
          </table>
          <div className="mt-4 flex justify-end gap-2"><button className="btn btn-ghost" onClick={() => setShort(null)}>{t('common.cancel')}</button><button className="btn btn-solid" onClick={() => { setShort(null); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>{t('common.back')}</button></div>
        </Modal>
      )}
    </div>
  )
}

function stockAmount(s: StockLine, v: number, lang: 'vi' | 'en') {
  return s.unit === 'mm' ? `${fmtNum(v / 1000, 3, lang)} m` : fmtNum(v, 0, lang)
}

function Results({ res, mname, t, lang, actual = false }: { res: CalculationResult; mname: (id: string) => string; t: ReturnType<typeof useI18n>['t']; lang: 'vi' | 'en'; actual?: boolean }) {
  const m = (mm: number) => `${fmtNum(mm / 1000, 3, lang)} m`
  const steps = res.steps
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('calc.r.pipes')} value={res.pipePlans.reduce((s, p) => s + p.newPipes, 0)} sub={res.pipePlans.map((p) => `${mname(p.pipeKey)}: ${p.newPipes}`).join(' | ')} />
        <Stat label={t('calc.r.screens')} value={m(res.locations.reduce((s, l) => s + l.screenMm, 0))} />
        <Stat label={t('calc.r.totalCaps')} value={res.caps.reduce((s, c) => s + c.total, 0)} sub={`${res.caps.reduce((s, c) => s + c.top, 0)} ${t('calc.r.topCaps').toLowerCase()} + ${res.caps.reduce((s, c) => s + c.bottom, 0)} ${t('calc.r.bottomCaps').toLowerCase()}`} />
        <Stat label={t('calc.r.newOffcuts')} value={m(res.pipePlans.reduce((s, p) => s + p.generatedMm, 0))} sub={`${res.pipePlans.reduce((s, p) => s + p.generated.length, 0)} ${t('common.pieces')}`} />
      </div>

      <div className="overflow-x-auto">
        <h3 className="label">{t('calc.r.byType')}</h3>
        <table className="tbl">
          <thead><tr><th>{t('common.type')}</th><th className="num">{t('hist.locations')}</th><th className="num">{t('calc.depth')}</th><th className="num">{t('calc.totalLength')}</th><th className="num">{t('calc.pvcLength')}</th><th className="num">{t('calc.screen')}</th><th className="num">{t('calc.r.topCaps')}</th><th className="num">{t('calc.r.bottomCaps')}</th></tr></thead>
          <tbody>{res.byType.map((x) => (
            <tr key={x.type}><td style={{ borderLeft: `6px solid ${TYPE_COLORS[x.type]}` }}>{typeShort(t, x.type)}</td><td className="num">{x.locations}</td><td className="num">{m(x.depthMm)}</td><td className="num">{m(x.totalMm)}</td><td className="num">{m(x.pvcMm)}</td><td className="num">{m(x.screenMm)}</td><td className="num">{x.topCaps}</td><td className="num">{x.bottomCaps}</td></tr>
          ))}</tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <h3 className="label">{t('calc.r.perLocation')}</h3>
        <table className="tbl">
          <thead><tr><th>{t('calc.location')}</th><th>{t('common.type')}</th><th className="num">{t('calc.depth')}</th><th className="num">{t('calc.projection')}</th><th className="num">{t('calc.totalLength')}</th><th className="num">{t('calc.screen')}</th><th className="num">{t('calc.pvcLength')}</th><th>{t('calc.segments')}</th></tr></thead>
          <tbody>{res.locations.map((l) => (
            <tr key={l.index}><td className="font-bold">{l.code}</td><td>{typeShort(t, l.type)}</td><td className="num">{formatMm(l.depthMm)}</td><td className="num">{formatMm(l.projectionMm)}</td><td className="num">{formatMm(l.totalMm)}</td><td className="num">{formatMm(l.screenMm)}</td><td className="num font-bold text-tva-orange">{formatMm(l.pvcMm)}</td><td>{l.segmentsMm.length ? l.segmentsMm.map(formatMm).join(' + ') + ' m' : '-'}</td></tr>
          ))}</tbody>
        </table>
      </div>

      <div>
        <h3 className="label">{actual ? t('calc.actualSaved') : t('calc.r.planned')}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="border-2 border-tva-brown p-3 text-sm">
            <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-tva-sand">{t('calc.r.fullToConsume')}</div>
            {res.pipePlans.map((p) => <div key={p.pipeKey} className="flex justify-between"><span>{mname(p.pipeKey)}</span><b className="text-tva-orange">{t('calc.pipesCount', { n: p.newPipes })} ({m(p.rawNewMm)})</b></div>)}
          </div>
          <div className="border-2 border-tva-brown p-3 text-sm">
            <div className="mb-1 text-[11px] font-bold uppercase tracking-widest text-tva-sand">{t('calc.r.offcutsToConsume')}</div>
            {res.pipePlans.every((p) => p.offcutsConsumed.length === 0) ? <span className="text-tva-sand">{t('common.none')}</span> : res.pipePlans.filter((p) => p.offcutsConsumed.length).map((p) => (
              <div key={p.pipeKey} className="flex justify-between gap-2"><span>{mname(p.pipeKey)}</span><b className="text-tva-teal">{p.offcutsConsumed.map((o) => formatMm(o.lengthMm)).join(' + ')} m</b></div>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <h3 className="label">{t('calc.r.cuttingPlan')}</h3>
        <table className="tbl">
          <thead><tr><th>{t('calc.r.step')}</th><th>{t('inv.material')}</th><th>{t('calc.r.source')}</th><th className="num">{t('calc.r.cut')}</th><th>{t('calc.r.useFor')}</th><th className="num">{t('calc.r.leftover')}</th></tr></thead>
          <tbody>{steps.map((s) => (
            <tr key={s.step}>
              <td>{s.step}</td><td>{mname(s.pipeKey)}</td>
              <td><Tag kind={s.source === 'stock' ? 'warn' : 'ok'}>{t(`calc.src.${s.source}` as TKey)}</Tag> <span className="text-tva-sand">{formatMm(s.sourceLengthMm)} m</span></td>
              <td className="num font-bold">{formatMm(s.cutMm)} m</td>
              <td>{res.locations[s.locationIndex].code}</td>
              <td className="num">{s.leftoverMm > 0 ? <span className="text-tva-teal">{formatMm(s.leftoverMm)} m</span> : s.scrapMm > 0 ? <span className="text-tva-red">{t('calc.r.scrap').split(' (')[0]} {formatMm(s.scrapMm)} m</span> : '-'}{s.kerfMm > 0 && <span className="ml-1 text-tva-sand">(-{formatMm(s.kerfMm)})</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="border-2 border-tva-brown p-3 text-sm">
          <h3 className="label">{t('calc.r.newOffcuts')} - {t('calc.r.piecesList')}</h3>
          {res.pipePlans.every((p) => p.generated.length === 0) ? <span className="text-tva-sand">{t('common.none')}</span> : res.pipePlans.map((p) => p.generated.length > 0 && (
            <div key={p.pipeKey} className="mb-1"><b>{mname(p.pipeKey)}</b>: {Object.entries(p.generated.reduce<Record<number, number>>((a, g) => ((a[g.lengthMm] = (a[g.lengthMm] ?? 0) + 1), a), {})).sort((a, b) => Number(b[0]) - Number(a[0])).map(([len, n]) => `${formatMm(Number(len))} m x ${n}`).join(', ')} <span className="text-tva-sand">= {m(p.generatedMm)}</span></div>
          ))}
          {res.pipePlans.map((p) => (p.scrapMm > 0 || p.kerfMm > 0) && <div key={'s' + p.pipeKey} className="text-[11px] text-tva-sand">{mname(p.pipeKey)}: {t('calc.r.scrap').split(' (')[0]} {m(p.scrapMm)}, {t('calc.r.kerf')} {m(p.kerfMm)}</div>)}
          {res.pipePlans.map((p) => <div key={'u' + p.pipeKey} className="text-[11px] text-tva-sand">{mname(p.pipeKey)}: {t('calc.r.rawNew')} {m(p.rawNewMm)} - {t('calc.r.unused')} {m(p.unusedMm)}{p.joints > 0 ? ` - ${t('calc.r.joints')}: ${p.joints}` : ''}</div>)}
        </div>
        <div className="overflow-x-auto border-2 border-tva-brown p-3 text-sm">
          <h3 className="label">{t('calc.r.offcutSummary')}</h3>
          <table className="tbl">
            <thead><tr><th>{t('inv.material')}</th><th className="num">{t('calc.r.before')}</th><th className="num">{t('calc.r.consumed')}</th><th className="num">{t('calc.r.generated')}</th><th className="num">{t('calc.r.afterOff')}</th></tr></thead>
            <tbody>{res.offcutLines.map((o) => (
              <tr key={o.pipeKey}><td>{mname(o.pipeKey)}</td><td className="num">{o.beforeCount} / {m(o.beforeMm)}</td><td className="num">-{o.consumedCount} / {m(o.consumedMm)}</td><td className="num">+{o.generatedCount} / {m(o.generatedMm)}</td><td className="num font-bold">{o.afterCount} / {m(o.afterMm)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      <div className="overflow-x-auto">
        <h3 className="label">{t('calc.r.availability')} / {t('calc.r.projected')}</h3>
        <table className="tbl">
          <thead><tr><th>{t('inv.material')}</th><th className="num">{t('calc.required')}</th><th className="num">{t('calc.available')}</th><th className="num">{t('calc.after')}</th><th>{t('common.status')}</th></tr></thead>
          <tbody>{res.stock.map((s) => (
            <tr key={s.key + s.bucket}>
              <td>{mname(s.key)} <span className="text-tva-sand">({bucketLabel(t, s.bucket)})</span></td>
              <td className="num">{stockAmount(s, s.required, lang)}</td><td className="num">{stockAmount(s, s.available, lang)}</td>
              <td className={`num font-bold ${s.missing ? 'text-tva-red' : ''}`}>{s.missing ? '-' + stockAmount(s, s.missing, lang) : stockAmount(s, s.after, lang)}</td>
              <td>{s.missing ? <Tag kind="bad">{t('calc.stockShort')} {stockAmount(s, s.missing, lang)}</Tag> : <Tag kind="ok">{t('calc.stockOk')}</Tag>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  )
}
