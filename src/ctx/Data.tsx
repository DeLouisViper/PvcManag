import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { BalanceRow, InstallationTypeRow, InventoryOverviewRow, Material, OffcutRow, Profile, SettingRow } from '../lib/dbTypes'
import { dbError, supabase } from '../lib/supabase'

interface Master {
  materials: Material[]
  itypes: InstallationTypeRow[]
  settings: SettingRow[]
  balances: BalanceRow[]
  offcuts: OffcutRow[]
  overview: InventoryOverviewRow[]
  profiles: Profile[]
}
interface Ctx extends Master {
  loading: boolean
  online: boolean
  error: string | null
  refresh: () => Promise<void>
  /** bumps every time inventory data was reloaded (lets pages detect a stale calculation) */
  version: number
  lowStock: InventoryOverviewRow[]
}
const empty: Master = { materials: [], itypes: [], settings: [], balances: [], offcuts: [], overview: [], profiles: [] }
const DataCtx = createContext<Ctx | null>(null)

export function isLow(r: InventoryOverviewRow): boolean {
  return Number(r.available) <= Number(r.low_stock_threshold)
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [m, setM] = useState<Master>(empty)
  const [loading, setLoading] = useState(true)
  const [online, setOnline] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const busy = useRef(false)

  const refresh = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      const [mat, it, st, bal, off, ov, pr] = await Promise.all([
        supabase.from('materials').select('*').order('sort_order'),
        supabase.from('installation_types').select('*').order('sort_order'),
        supabase.from('material_settings').select('*'),
        supabase.from('inventory_balances').select('*'),
        supabase.from('pipe_offcuts').select('*').eq('status', 'available').order('length'),
        supabase.rpc('get_inventory_overview'),
        supabase.from('profiles').select('*').order('full_name'),
      ])
      const err = [mat, it, st, bal, off, ov, pr].find((r) => r.error)?.error
      if (err) throw err
      setM({
        materials: mat.data as Material[],
        itypes: it.data as InstallationTypeRow[],
        settings: st.data as SettingRow[],
        balances: bal.data as BalanceRow[],
        offcuts: off.data as OffcutRow[],
        overview: ov.data as InventoryOverviewRow[],
        profiles: pr.data as Profile[],
      })
      setOnline(true)
      setError(null)
      setVersion((v) => v + 1)
    } catch (e) {
      setOnline(false)
      setError(dbError(e).message)
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 60000)
    const onVis = () => document.visibilityState === 'visible' && void refresh()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [refresh])

  const lowStock = useMemo(() => m.overview.filter(isLow), [m.overview])
  const value = useMemo(() => ({ ...m, loading, online, error, refresh, version, lowStock }), [m, loading, online, error, refresh, version, lowStock])
  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>
}

export function useData(): Ctx {
  const c = useContext(DataCtx)
  if (!c) throw new Error('useData outside provider')
  return c
}
