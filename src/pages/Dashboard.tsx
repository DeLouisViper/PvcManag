import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart, LineChart } from '../components/charts'
import { Empty, Panel, PageTitle, Spinner, Stat, Tag } from '../components/ui'
import { useData } from '../ctx/Data'
import type { DashboardSummary, InventoryOverviewRow, LedgerRow } from '../lib/dbTypes'
import { INSTALLATION_TYPES } from '../lib/engine'
import { fmtDateTime, fmtNum } from '../lib/format'
import { useI18n } from '../lib/i18n'
import type { TKey } from '../lib/i18n/en'
import { matName, typeShort, TYPE_COLORS } from '../lib/labels'
import { supabase } from '../lib/supabase'

const DIAS = ['D35', 'D55', 'D90'] as const

export function Dashboard() {
  const { t, lang } = useI18n()
  const { overview, materials, loading, version } = useData()
  const [sum, setSum] = useState<DashboardSummary | null>(null)
  const [recent, setRecent] = useState<LedgerRow[] | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [s, r] = await Promise.all([
        supabase.rpc('get_dashboard_summary', { p_days: 30, p_tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').replace('Asia/Saigon', 'Asia/Ho_Chi_Minh') }),
        supabase.from('inventory_transactions').select('*').order('created_at', { ascending: false }).limit(8),
      ])
      if (!alive) return
      if (!s.error) setSum(s.data as DashboardSummary)
      setRecent(r.error ? [] : (r.data as LedgerRow[]))
    })()
    return () => { alive = false }
  }, [version])

  const by = useMemo(() => {
    const pipes = overview.filter((o) => o.category === 'pipe')
    const screens = overview.filter((o) => o.category === 'screen')
    const caps = overview.filter((o) => o.category === 'cap')
    return { pipes, screens, caps }
  }, [overview])
  const matById = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials])
  const low = overview.filter((o) => Number(o.available) <= Number(o.low_stock_threshold))

  if (loading) return <Spinner />

  const statusOf = (o: InventoryOverviewRow) => (Number(o.available) <= 0 ? 'empty' : Number(o.available) <= Number(o.low_stock_threshold) ? 'low' : 'ok')
  const dia = (list: InventoryOverviewRow[], d: string) => list.find((x) => x.diameter === d)

  // charts
  const stockByType = [
    { label: t('mat.pipe'), value: by.pipes.reduce((s, o) => s + Number(o.available), 0) },
    { label: t('mat.screen') + ' (m)', value: by.screens.reduce((s, o) => s + Number(o.available), 0) },
    { label: t('mat.cap'), value: by.caps.reduce((s, o) => s + Number(o.available), 0) },
  ]
  const pvcByDia = DIAS.map((d) => ({ label: d, value: Number(dia(by.pipes, d)?.available ?? 0) }))
  const cons = sum?.consumption ?? []
  const recentByType = INSTALLATION_TYPES.map((ty) => ({ label: typeShort(t, ty), value: Number(sum?.by_type.find((x) => x.type === ty)?.locations ?? 0), color: TYPE_COLORS[ty] }))

  return (
    <div className="animate-boot space-y-4">
      <PageTitle sub={t('shell.status') + ': ' + t('shell.online')}>{t('dash.title')}</PageTitle>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('dash.installations')} value={fmtNum(sum?.installations_completed ?? 0, 0, lang)} sub={`${fmtNum(sum?.locations_completed ?? 0, 0, lang)} ${t('dash.locations').toLowerCase()}`} />
        <Stat label={t('dash.totalDepth')} value={`${fmtNum(Number(sum?.total_depth ?? 0), 3, lang)} m`} />
        <Stat label={t('dash.lowStock')} value={low.length} kind={low.length ? 'warn' : 'ok'} sub={low.length ? low.map((l) => l.sku).join(', ') : t('dash.noWarnings')} />
        <Stat label={t('dash.offcuts')} value={`${fmtNum(by.pipes.reduce((s, o) => s + Number(o.offcut_total), 0), 3, lang)} m`} sub={DIAS.map((d) => `${d}: ${fmtNum(Number(dia(by.pipes, d)?.offcut_total ?? 0), 2, lang)} m`).join(' | ')} />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Panel title={t('dash.fullPipes')}>
          <div className="space-y-1 text-sm">{DIAS.map((d) => <Row key={d} k={`PVC ${d}`} v={`${fmtNum(Number(dia(by.pipes, d)?.available ?? 0), 0, lang)} ${t('common.pcs')}`} sub={`+ ${dia(by.pipes, d)?.offcut_count ?? 0} ${t('common.pieces')}`} />)}</div>
        </Panel>
        <Panel title={t('dash.screens')}>
          <div className="space-y-1 text-sm">{(['D35', 'D55'] as const).map((d) => <Row key={d} k={`${t('mat.screen')} ${d}`} v={`${fmtNum(Number(dia(by.screens, d)?.available ?? 0), 3, lang)} m`} />)}</div>
        </Panel>
        <Panel title={t('dash.caps')}>
          <div className="space-y-1 text-sm">{DIAS.map((d) => <Row key={d} k={`${t('mat.cap')} ${d}`} v={`${fmtNum(Number(dia(by.caps, d)?.available ?? 0), 0, lang)} ${t('common.pcs')}`} />)}</div>
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title={t('dash.chart.stock')}><BarChart data={stockByType} /></Panel>
        <Panel title={t('dash.chart.pvc')}><BarChart data={pvcByDia} unit={' ' + t('common.pcs')} /></Panel>
        <Panel title={t('dash.chart.consumption')}>
          {cons.length === 0 ? <Empty>{t('dash.noConsumption')}</Empty> : (
            <LineChart labels={cons.map((c) => c.day.slice(5))} series={[
              { name: t('dash.pipesUsed'), color: '#ff8a1f', values: cons.map((c) => Number(c.pipes ?? 0)) },
              { name: t('dash.screenUsed'), color: '#52c4b0', values: cons.map((c) => Number(c.screen_m ?? 0)) },
              { name: t('dash.capsUsed'), color: '#ffb54a', values: cons.map((c) => Number(c.caps ?? 0)) },
            ]} />
          )}
        </Panel>
        <Panel title={t('dash.chart.recent')}><BarChart data={recentByType} /></Panel>
      </div>

      <Panel title={t('dash.statusTable')} bodyClass="overflow-x-auto !p-0">
        <table className="tbl">
          <thead><tr><th>{t('inv.material')}</th><th className="num">{t('dash.fullAvail')}</th><th className="num">{t('inv.offcutPieces')} / m</th><th className="num">{t('dash.screenAvail')}</th><th className="num">{t('dash.capAvail')}</th><th>{t('common.status')}</th></tr></thead>
          <tbody>
            {overview.map((o) => {
              const s = statusOf(o)
              return (
                <tr key={o.material_id}>
                  <td><span className="font-bold">{o.sku}</span> <span className="text-tva-sand">{matName(matById.get(o.material_id), lang)}</span></td>
                  <td className="num">{o.category === 'pipe' ? fmtNum(Number(o.available), 0, lang) : '-'}</td>
                  <td className="num">{o.category === 'pipe' ? `${o.offcut_count} / ${fmtNum(Number(o.offcut_total), 3, lang)} m` : '-'}</td>
                  <td className="num">{o.category === 'screen' ? fmtNum(Number(o.available), 3, lang) : '-'}</td>
                  <td className="num">{o.category === 'cap' ? fmtNum(Number(o.available), 0, lang) : '-'}</td>
                  <td><Tag kind={s === 'ok' ? 'ok' : s === 'low' ? 'warn' : 'bad'}>{t(`dash.status.${s}` as TKey)}</Tag> <span className="text-[10px] text-tva-sand">{t('dash.threshold')} {fmtNum(Number(o.low_stock_threshold), 1, lang)}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Panel>

      <Panel title={t('dash.recentTx')} right={<Link className="text-tva-orange hover:underline" to="/transactions">{t('dash.viewAll')} &gt;</Link>} bodyClass="overflow-x-auto !p-0">
        {recent === null ? <Spinner /> : recent.length === 0 ? <div className="p-3"><Empty>{t('common.noData')}</Empty></div> : (
          <table className="tbl">
            <thead><tr><th>{t('common.date')}</th><th>{t('tx.ref')}</th><th>{t('common.type')}</th><th>{t('tx.material')}</th><th className="num">{t('tx.qty')}</th></tr></thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{fmtDateTime(r.created_at, lang)}</td>
                  <td>{r.tx_ref}</td>
                  <td>{t(`tx.type.${r.tx_type}` as TKey)}</td>
                  <td>{matById.get(r.material_id)?.sku ?? '?'} <span className="text-tva-sand">({t(`tx.bucket.${r.bucket}` as TKey)})</span></td>
                  <td className={`num font-bold ${Number(r.quantity) < 0 ? 'text-tva-red' : 'text-tva-teal'}`}>{Number(r.quantity) > 0 ? '+' : ''}{fmtNum(Number(r.quantity), 3, lang)} {r.unit === 'm' ? 'm' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}

function Row({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return <div className="flex items-baseline justify-between gap-2 border-b border-tva-brown-dark pb-1"><span className="text-tva-sand">{k}</span><span className="font-bold text-tva-orange">{v}{sub && <span className="ml-2 text-[11px] font-normal text-tva-sand">{sub}</span>}</span></div>
}
