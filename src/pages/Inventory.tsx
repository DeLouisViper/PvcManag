import { useMemo, useState } from 'react'
import { ConfirmDialog, Empty, Field, Panel, PageTitle, Spinner, Tag } from '../components/ui'
import { useMe } from '../ctx/Auth'
import { isLow, useData } from '../ctx/Data'
import { useToast } from '../ctx/Toast'
import type { Material } from '../lib/dbTypes'
import { fmtDateTime, fmtNum, todayIso } from '../lib/format'
import { useI18n } from '../lib/i18n'
import type { TKey } from '../lib/i18n/en'
import { matName } from '../lib/labels'
import { dbError, supabase } from '../lib/supabase'

type Tab = 'opening' | 'purchase' | 'adjust'

export function Inventory() {
  const { t, lang } = useI18n()
  const { isAdmin } = useMe()
  const { overview, materials, offcuts, loading, refresh } = useData()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('opening')
  const [open, setOpen] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const mById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials])

  if (loading) return <Spinner />

  const verify = async () => {
    setChecking(true)
    const { data, error } = await supabase.rpc('verify_inventory_integrity')
    setChecking(false)
    if (error) return toast.push('err', dbError(error).message)
    const bad = (data as { ok: boolean }[]).filter((r) => !r.ok).length
    if (bad === 0) toast.push('ok', t('inv.integrityOk'))
    else toast.push('err', t('inv.integrityBad', { n: bad }))
  }

  const offcutsOf = (id: string) => {
    const g = new Map<number, number>()
    for (const o of offcuts) if (o.material_id === id) g.set(Number(o.length), (g.get(Number(o.length)) ?? 0) + 1)
    return [...g].sort((a, b) => b[0] - a[0])
  }

  return (
    <div className="animate-boot space-y-4">
      <PageTitle right={<button className="btn" onClick={() => void verify()} disabled={checking}>{t('inv.integrity')}</button>}>{t('inv.title')}</PageTitle>

      <Panel title={t('inv.title')} bodyClass="overflow-x-auto !p-0">
        <table className="tbl min-w-[1000px]">
          <thead><tr>
            <th>{t('inv.material')}</th><th>{t('mat.category')}</th><th>{t('mat.diameter')}</th><th className="num">{t('inv.stockLength')}</th>
            <th className="num">{t('inv.opening')}</th><th className="num">{t('inv.purchased')}</th><th className="num">{t('inv.consumed')}</th><th className="num">{t('inv.adjusted')}</th><th className="num">{t('inv.reversed')}</th>
            <th className="num">{t('inv.available')}</th><th className="num">{t('inv.offcutPieces')}</th><th className="num">{t('inv.offcutTotal')}</th><th className="num">{t('inv.reserved')}</th><th>{t('inv.lastTx')}</th>
          </tr></thead>
          <tbody>
            {overview.map((o) => {
              const unit = o.category === 'screen' ? ' m' : ''
              const f = (v: number) => fmtNum(Number(v), o.category === 'screen' ? 3 : 0, lang)
              const low = isLow(o)
              return (
                <>
                  <tr key={o.material_id}>
                    <td><div className="font-bold">{o.sku}</div><div className="text-[11px] text-tva-sand">{matName(mById.get(o.material_id), lang)}</div></td>
                    <td>{t(`mat.${o.category}` as TKey)}</td><td>{o.diameter}</td>
                    <td className="num">{o.stock_length ? `${fmtNum(Number(o.stock_length), 3, lang)} m` : '-'}</td>
                    <td className="num">{f(o.opening)}{unit}</td><td className="num">{f(o.purchased)}{unit}</td><td className="num">{f(o.consumed)}{unit}</td>
                    <td className="num">{Number(o.adjusted) > 0 ? '+' : ''}{f(o.adjusted)}{unit}</td><td className="num">{f(o.reversed)}{unit}</td>
                    <td className="num"><span className={`text-base font-bold ${low ? 'text-tva-amber' : 'text-tva-orange'}`}>{f(o.available)}{unit}</span> {low && <Tag kind="warn">{t('dash.status.low')}</Tag>}</td>
                    <td className="num">{o.category === 'pipe' ? (
                      <button className="text-tva-teal underline decoration-dotted" onClick={() => setOpen(open === o.material_id ? null : o.material_id)} aria-expanded={open === o.material_id}>{o.offcut_count}</button>
                    ) : '-'}</td>
                    <td className="num">{o.category === 'pipe' ? `${fmtNum(Number(o.offcut_total), 3, lang)} m` : '-'}</td>
                    <td className="num text-tva-sand">{t('inv.reservedNone')}</td>
                    <td className="whitespace-nowrap text-[11px]">{fmtDateTime(o.last_tx_at, lang)}</td>
                  </tr>
                  {open === o.material_id && (
                    <tr key={o.material_id + 'o'}><td colSpan={14} className="bg-tva-dark">
                      <div className="text-[11px] font-bold uppercase tracking-widest text-tva-sand">{t('inv.offcutList')}</div>
                      {offcutsOf(o.material_id).length === 0 ? <span className="text-tva-sand">{t('inv.noOffcuts')}</span> : (
                        <div className="mt-1 flex flex-wrap gap-2">{offcutsOf(o.material_id).map(([len, n]) => <Tag key={len} kind="ok">{fmtNum(len, 3, lang)} m x {n}</Tag>)}</div>
                      )}
                    </td></tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </Panel>

      {isAdmin ? (
        <Panel title={t('inv.admin')}>
          <div className="mb-3 flex flex-wrap gap-2">
            {(['opening', 'purchase', 'adjust'] as Tab[]).map((x) => (
              <button key={x} className={`btn ${tab === x ? 'btn-solid' : ''}`} onClick={() => setTab(x)}>{t(x === 'opening' ? 'inv.openingStock' : x === 'purchase' ? 'inv.purchase' : 'inv.adjustment')}</button>
            ))}
          </div>
          {tab === 'opening' && <OpeningForm materials={materials} onDone={refresh} />}
          {tab === 'purchase' && <PurchaseForm materials={materials} onDone={refresh} />}
          {tab === 'adjust' && <AdjustForm materials={materials} onDone={refresh} />}
        </Panel>
      ) : (
        <Empty>{t('calc.permissionNote')}</Empty>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ opening stock
interface Line { id: number; materialId: string; kind: string; quantity: string; length: string }
let lineSeq = 1
const kindsFor = (m: Material | undefined) => (!m ? [] : m.category === 'pipe' ? ['full', 'offcut'] : m.category === 'screen' ? ['screen'] : ['cap'])

function OpeningForm({ materials, onDone }: { materials: Material[]; onDone: () => Promise<void> }) {
  const { t, lang } = useI18n()
  const toast = useToast()
  const mk = (): Line => ({ id: lineSeq++, materialId: materials[0]?.id ?? '', kind: 'full', quantity: '', length: '' })
  const [lines, setLines] = useState<Line[]>(() => [mk()])
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const by = new Map(materials.map((m) => [m.id, m]))
  const upd = (id: number, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)))

  const valid = lines.every((l) => {
    const q = Number(l.quantity)
    const needLen = l.kind === 'offcut' || l.kind === 'screen'
    return l.materialId && Number.isInteger(q) && q > 0 && (!needLen || Number(l.length.replace(',', '.')) > 0)
  })

  const submit = async () => {
    setBusy(true)
    setConfirm(false)
    try {
      const items = lines.map((l) => ({ material_id: l.materialId, kind: l.kind, quantity: Number(l.quantity), length: l.kind === 'offcut' || l.kind === 'screen' ? Number(l.length.replace(',', '.')) : null }))
      const { data, error } = await supabase.rpc('admin_record_opening_stock', { p_items: items, p_notes: notes.trim() || null })
      if (error) throw error
      toast.push('ok', t('inv.openingDone', { ref: (data as { transaction_ref: string }).transaction_ref }))
      setLines([mk()])
      setNotes('')
      await onDone()
    } catch (e) {
      toast.push('err', dbError(e).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-tva-sand">{t('inv.openingHint')}</p>
      {lines.map((l) => {
        const m = by.get(l.materialId)
        const kinds = kindsFor(m)
        return (
          <div key={l.id} className="grid items-end gap-2 sm:grid-cols-[2fr_1.2fr_1fr_1.4fr_auto]">
            <Field label={t('inv.material')}>
              <select className="field" value={l.materialId} onChange={(e) => upd(l.id, { materialId: e.target.value, kind: kindsFor(by.get(e.target.value))[0], length: '' })}>
                {materials.map((x) => <option key={x.id} value={x.id}>{x.sku} - {matName(x, lang)}</option>)}
              </select>
            </Field>
            <Field label={t('inv.kind')}>
              <select className="field" value={l.kind} onChange={(e) => upd(l.id, { kind: e.target.value })}>{kinds.map((k) => <option key={k} value={k}>{t(`inv.kind.${k}` as TKey)}</option>)}</select>
            </Field>
            <Field label={t('common.quantity')}><input className="field num" inputMode="numeric" value={l.quantity} onChange={(e) => upd(l.id, { quantity: e.target.value })} /></Field>
            <Field label={t('inv.eachLength')}><input className="field num" inputMode="decimal" disabled={l.kind !== 'offcut' && l.kind !== 'screen'} value={l.length} onChange={(e) => upd(l.id, { length: e.target.value })} /></Field>
            <button className="btn btn-danger" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))} aria-label={t('common.remove')}>x</button>
          </div>
        )
      })}
      <Field label={t('common.notes')}><input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></Field>
      <div className="flex gap-2">
        <button className="btn" onClick={() => setLines((ls) => [...ls, mk()])}>+ {t('inv.addLine')}</button>
        <button className="btn btn-solid ml-auto" disabled={!valid || busy} onClick={() => setConfirm(true)}>{t('inv.recordOpening')}</button>
      </div>
      {confirm && <ConfirmDialog title={t('inv.openingStock')} confirmLabel={t('common.confirm')} onConfirm={() => void submit()} onCancel={() => setConfirm(false)} busy={busy}><p className="text-sm">{lines.length} {t('common.add').toLowerCase()}...</p></ConfirmDialog>}
    </div>
  )
}

// ------------------------------------------------------------------ purchase
function PurchaseForm({ materials, onDone }: { materials: Material[]; onDone: () => Promise<void> }) {
  const { t, lang } = useI18n()
  const toast = useToast()
  const [materialId, setMaterialId] = useState(materials[0]?.id ?? '')
  const [date, setDate] = useState(todayIso())
  const [supplier, setSupplier] = useState('')
  const [qty, setQty] = useState('')
  const [totalLen, setTotalLen] = useState('')
  const [ref, setRef] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const m = materials.find((x) => x.id === materialId)
  const isScreen = m?.category === 'screen'
  const q = Number(qty)
  const ok = !!m && Number.isInteger(q) && q > 0 && (!isScreen || Number(totalLen.replace(',', '.')) > 0)

  const submit = async () => {
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('admin_record_purchase', { p: { material_id: materialId, purchase_date: date, supplier, quantity: q, total_length: isScreen ? Number(totalLen.replace(',', '.')) : null, reference_no: ref, notes } })
      if (error) throw error
      toast.push('ok', t('inv.purchaseDone', { ref: (data as { ref: string }).ref }))
      setQty(''); setTotalLen(''); setRef(''); setNotes('')
      await onDone()
    } catch (e) {
      toast.push('err', dbError(e).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Field label={t('inv.material')}><select className="field" value={materialId} onChange={(e) => setMaterialId(e.target.value)}>{materials.map((x) => <option key={x.id} value={x.id}>{x.sku} - {matName(x, lang)}</option>)}</select></Field>
      <Field label={t('inv.purchaseDate')}><input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label={<>{t('inv.supplier')} ({t('common.optional')})</>}><input className="field" value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={120} /></Field>
      <Field label={`${t('common.quantity')} (${t('common.pcs')})`}><input className="field num" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
      {isScreen && <Field label={t('inv.totalLength')}><input className="field num" inputMode="decimal" value={totalLen} onChange={(e) => setTotalLen(e.target.value)} /></Field>}
      <Field label={<>{t('inv.referenceNo')} ({t('common.optional')})</>}><input className="field" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={80} /></Field>
      <Field label={t('common.notes')}><input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></Field>
      <div className="flex items-end"><button className="btn btn-solid" disabled={!ok || busy} onClick={() => void submit()}>{t('inv.recordPurchase')}</button></div>
    </div>
  )
}

// ------------------------------------------------------------------ adjustment
function AdjustForm({ materials, onDone }: { materials: Material[]; onDone: () => Promise<void> }) {
  const { t, lang } = useI18n()
  const toast = useToast()
  const { offcuts } = useData()
  const [materialId, setMaterialId] = useState(materials[0]?.id ?? '')
  const m = materials.find((x) => x.id === materialId)
  const buckets = !m ? [] : m.category === 'pipe' ? ['full', 'offcut'] : [m.category === 'screen' ? 'screen' : 'cap']
  const [bucket, setBucket] = useState('full')
  const [delta, setDelta] = useState('')
  const [action, setAction] = useState<'remove' | 'add'>('remove')
  const [offcutId, setOffcutId] = useState('')
  const [offLen, setOffLen] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const b = buckets.includes(bucket) ? bucket : buckets[0]
  const mine = offcuts.filter((o) => o.material_id === materialId)
  const d = Number(delta.replace(',', '.'))
  const reasonOk = reason.trim().length >= 3
  const ok = reasonOk && (b === 'offcut' ? (action === 'remove' ? !!offcutId : Number(offLen.replace(',', '.')) > 0) : Number.isFinite(d) && d !== 0)

  const submit = async () => {
    setBusy(true)
    setConfirm(false)
    try {
      const { data, error } = await supabase.rpc('admin_adjust_inventory', {
        p_material_id: materialId, p_bucket: b, p_delta: b === 'offcut' ? 0 : d, p_reason: reason.trim(),
        p_offcut_id: b === 'offcut' && action === 'remove' ? offcutId : null,
        p_offcut_length: b === 'offcut' && action === 'add' ? Number(offLen.replace(',', '.')) : null,
      })
      if (error) throw error
      toast.push('ok', t('inv.adj.done', { ref: (data as { transaction_ref: string }).transaction_ref }))
      setDelta(''); setReason(''); setOffcutId(''); setOffLen('')
      await onDone()
    } catch (e) {
      toast.push('err', dbError(e).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-tva-sand">{t('inv.adj.hint')}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t('inv.material')}><select className="field" value={materialId} onChange={(e) => { setMaterialId(e.target.value); setOffcutId('') }}>{materials.map((x) => <option key={x.id} value={x.id}>{x.sku} - {matName(x, lang)}</option>)}</select></Field>
        <Field label={t('inv.adj.bucket')}><select className="field" value={b} onChange={(e) => setBucket(e.target.value)}>{buckets.map((x) => <option key={x} value={x}>{t(`inv.adj.bucket.${x}` as TKey)}</option>)}</select></Field>
        {b !== 'offcut' ? (
          <Field label={t('inv.adj.delta')}><input className="field num" inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value)} /></Field>
        ) : (
          <>
            <Field label={t('inv.adj.offcutAction')}><select className="field" value={action} onChange={(e) => setAction(e.target.value as 'remove' | 'add')}><option value="remove">{t('inv.adj.removeOffcut')}</option><option value="add">{t('inv.adj.addOffcut')}</option></select></Field>
            {action === 'remove' ? (
              <Field label={t('inv.adj.pick')}><select className="field" value={offcutId} onChange={(e) => setOffcutId(e.target.value)}><option value="">-</option>{mine.map((o) => <option key={o.id} value={o.id}>{fmtNum(Number(o.length), 3, lang)} m - {o.id.slice(0, 8)}</option>)}</select></Field>
            ) : (
              <Field label={t('inv.eachLength')}><input className="field num" inputMode="decimal" value={offLen} onChange={(e) => setOffLen(e.target.value)} /></Field>
            )}
          </>
        )}
      </div>
      <Field label={t('inv.adj.reason')}><input className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
      <button className="btn btn-solid" disabled={!ok || busy} onClick={() => setConfirm(true)}>{t('inv.adj.record')}</button>
      {confirm && <ConfirmDialog title={t('inv.adjustment')} body={reason} confirmLabel={t('common.confirm')} onConfirm={() => void submit()} onCancel={() => setConfirm(false)} busy={busy} />}
    </div>
  )
}
