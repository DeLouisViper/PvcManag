import { useCallback, useEffect, useMemo, useState } from 'react'
import { Empty, Field, Panel, PageTitle, Spinner, Tag } from '../components/ui'
import { useMe } from '../ctx/Auth'
import { useData } from '../ctx/Data'
import { useToast } from '../ctx/Toast'
import type { LedgerRow } from '../lib/dbTypes'
import { downloadCsv } from '../lib/export'
import { fmtDateTime, fmtNum } from '../lib/format'
import { useI18n } from '../lib/i18n'
import type { TKey } from '../lib/i18n/en'
import { matName } from '../lib/labels'
import { dbError, supabase } from '../lib/supabase'

const LIMIT = 500
const TYPES = ['opening_stock', 'purchase', 'installation_issue', 'offcut_generated', 'offcut_consumed', 'adjustment', 'reversal'] as const
interface Audit { id: number; created_at: string; user_id: string | null; action: string; entity: string; entity_id: string | null; details: unknown }

export function Transactions() {
  const { t, lang } = useI18n()
  const { isAdmin } = useMe()
  const { materials, profiles } = useData()
  const toast = useToast()
  const [tab, setTab] = useState<'ledger' | 'audit'>('ledger')
  const [rows, setRows] = useState<LedgerRow[] | null>(null)
  const [audit, setAudit] = useState<Audit[] | null>(null)
  const [type, setType] = useState('')
  const [mat, setMat] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const mById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials])
  const nameOf = useMemo(() => new Map(profiles.map((p) => [p.id, p.full_name || p.email])), [profiles])

  const load = useCallback(async () => {
    let qy = supabase.from('inventory_transactions').select('*').order('created_at', { ascending: false }).order('tx_ref', { ascending: false }).limit(LIMIT)
    if (type) qy = qy.eq('tx_type', type)
    if (mat) qy = qy.eq('material_id', mat)
    if (from) qy = qy.gte('created_at', new Date(from + 'T00:00:00').toISOString())
    if (to) qy = qy.lte('created_at', new Date(to + 'T23:59:59').toISOString())
    const { data, error } = await qy
    if (error) { toast.push('err', dbError(error).message); setRows([]) } else setRows(data as LedgerRow[])
  }, [type, mat, from, to, toast])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (tab === 'audit' && isAdmin && audit === null) {
      void supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(LIMIT).then(({ data, error }) => { if (error) toast.push('err', dbError(error).message); setAudit((data as Audit[]) ?? []) })
    }
  }, [tab, isAdmin, audit, toast])

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (rows ?? []).filter((r) => !s || r.tx_ref.toLowerCase().includes(s) || r.group_ref.toLowerCase().includes(s) || (r.notes ?? '').toLowerCase().includes(s))
  }, [rows, q])

  const exportCsv = () => downloadCsv('stock-transactions.csv', [
    [t('tx.ref'), t('tx.group'), t('common.date'), t('common.type'), 'SKU', t('tx.material'), 'bucket', t('tx.qty'), t('common.unit'), t('tx.before'), t('tx.after'), t('common.user'), t('tx.notes')],
    ...shown.map((r) => [r.tx_ref, r.group_ref, r.created_at, r.tx_type, mById.get(r.material_id)?.sku ?? '', matName(mById.get(r.material_id), lang), r.bucket, r.quantity, r.unit, r.balance_before, r.balance_after, nameOf.get(r.user_id) ?? '', r.notes ?? '']),
  ])

  if (rows === null) return <Spinner />
  const denied = rows.length === 0 && !type && !mat && !from && !to && !isAdmin
  return (
    <div className="animate-boot space-y-4">
      <PageTitle sub={t('tx.immutable')} right={<button className="btn" onClick={exportCsv} disabled={!shown.length}>{t('common.export')} {t('common.csv')}</button>}>{t('tx.title')}</PageTitle>
      {isAdmin && <div className="flex gap-2"><button className={`btn ${tab === 'ledger' ? 'btn-solid' : ''}`} onClick={() => setTab('ledger')}>{t('tx.tabLedger')}</button><button className={`btn ${tab === 'audit' ? 'btn-solid' : ''}`} onClick={() => setTab('audit')}>{t('tx.tabAudit')}</button></div>}

      {tab === 'ledger' && (
        <>
          <Panel><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label={t('common.search')}><input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="TX- / TXN- / ..." /></Field>
            <Field label={t('tx.filterType')}><select className="field" value={type} onChange={(e) => setType(e.target.value)}><option value="">{t('common.all')}</option>{TYPES.map((x) => <option key={x} value={x}>{t(`tx.type.${x}` as TKey)}</option>)}</select></Field>
            <Field label={t('tx.filterMaterial')}><select className="field" value={mat} onChange={(e) => setMat(e.target.value)}><option value="">{t('common.all')}</option>{materials.map((m) => <option key={m.id} value={m.id}>{m.sku}</option>)}</select></Field>
            <Field label={t('common.from')}><input className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label={t('common.to')}><input className="field" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </div></Panel>
          {denied ? <Empty>{t('tx.denied')}</Empty> : shown.length === 0 ? <Empty>{t('common.noData')}</Empty> : (
            <Panel bodyClass="overflow-x-auto !p-0">
              <table className="tbl min-w-[1000px]">
                <thead><tr><th>{t('common.date')}</th><th>{t('tx.ref')}</th><th>{t('tx.group')}</th><th>{t('common.type')}</th><th>{t('tx.material')}</th><th className="num">{t('tx.qty')}</th><th className="num">{t('tx.before')}</th><th className="num">{t('tx.after')}</th><th>{t('common.user')}</th><th>{t('tx.notes')}</th></tr></thead>
                <tbody>{shown.map((r) => {
                  const m = r.unit === 'm'
                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{fmtDateTime(r.created_at, lang)}</td><td className="whitespace-nowrap">{r.tx_ref}</td><td className="whitespace-nowrap text-tva-sand">{r.group_ref}</td>
                      <td><Tag kind={r.tx_type === 'reversal' || r.tx_type === 'adjustment' ? 'warn' : r.tx_type === 'installation_issue' || r.tx_type === 'offcut_consumed' ? 'bad' : 'ok'}>{t(`tx.type.${r.tx_type}` as TKey)}</Tag></td>
                      <td>{mById.get(r.material_id)?.sku ?? '?'} <span className="text-tva-sand">({t(`tx.bucket.${r.bucket}` as TKey)})</span></td>
                      <td className={`num font-bold ${Number(r.quantity) < 0 ? 'text-tva-red' : 'text-tva-teal'}`}>{Number(r.quantity) > 0 ? '+' : ''}{fmtNum(Number(r.quantity), 3, lang)}{m ? ' m' : ''}</td>
                      <td className="num">{fmtNum(Number(r.balance_before), 3, lang)}</td><td className="num">{fmtNum(Number(r.balance_after), 3, lang)}</td>
                      <td>{nameOf.get(r.user_id) ?? '-'}</td><td className="max-w-xs break-words text-xs text-tva-sand">{r.notes}</td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </Panel>
          )}
          {rows.length >= LIMIT && <p className="text-xs text-tva-sand">{t('tx.limit', { n: LIMIT })}</p>}
        </>
      )}

      {tab === 'audit' && isAdmin && (audit === null ? <Spinner /> : (
        <Panel title={t('tx.audit')} bodyClass="overflow-x-auto !p-0">
          <table className="tbl min-w-[800px]">
            <thead><tr><th>{t('common.date')}</th><th>{t('common.user')}</th><th>{t('tx.auditAction')}</th><th>{t('tx.auditEntity')}</th><th>{t('tx.auditDetails')}</th></tr></thead>
            <tbody>{audit.map((a) => <tr key={a.id}><td className="whitespace-nowrap">{fmtDateTime(a.created_at, lang)}</td><td>{a.user_id ? nameOf.get(a.user_id) ?? a.user_id.slice(0, 8) : '-'}</td><td className="font-bold">{a.action}</td><td className="text-tva-sand">{a.entity}</td><td className="max-w-md break-words text-[11px] text-tva-sand">{JSON.stringify(a.details)}</td></tr>)}</tbody>
          </table>
        </Panel>
      ))}
    </div>
  )
}
