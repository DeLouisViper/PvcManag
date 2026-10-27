import type { BalanceRow, InstallationTypeRow, Material, OffcutRow, SettingRow } from './dbTypes'
import type { EngineConfig, InstallationType, InventoryInput, TypeConfig } from './engine'

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
const toMm = (m: unknown): number => Math.round(num(m) * 1000)

export function settingsMap(rows: SettingRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const r of rows) out[r.key] = r.value
  return out
}

/** Turn database settings + installation type mapping into the engine configuration. */
export function buildEngineConfig(itypes: InstallationTypeRow[], settings: Record<string, unknown>): EngineConfig {
  const types = {} as Record<InstallationType, TypeConfig>
  for (const t of itypes) {
    types[t.code] = {
      type: t.code,
      pipeKey: t.pipe_material_id,
      screenKey: t.screen_material_id,
      capKey: t.cap_material_id,
      projectionMm: toMm(settings[t.projection_setting]),
      defaultScreenMm: t.screen_setting ? toMm(settings[t.screen_setting]) : 0,
    }
  }
  const enabled = settings['cutting_allowance_enabled'] === true
  return {
    stockLengthMm: toMm(settings['pipe_stock_length']),
    cuttingAllowanceMm: enabled ? toMm(settings['cutting_allowance']) : 0,
    minOffcutMm: toMm(settings['min_offcut_length']),
    allowJoints: settings['allow_joints'] !== false,
    types,
  }
}

/** Current stock as the engine needs it. Keys are material ids. */
export function buildInventoryInput(materials: Material[], balances: BalanceRow[], offcuts: OffcutRow[]): InventoryInput {
  const inv: InventoryInput = { fullPipes: {}, offcuts: {}, screensMm: {}, caps: {} }
  for (const m of materials) {
    if (m.category === 'pipe') {
      inv.fullPipes[m.id] = 0
      inv.offcuts[m.id] = []
    } else if (m.category === 'screen') inv.screensMm[m.id] = 0
    else inv.caps[m.id] = 0
  }
  for (const b of balances) {
    if (b.bucket === 'full') inv.fullPipes[b.material_id] = Math.round(num(b.quantity))
    else if (b.bucket === 'screen') inv.screensMm[b.material_id] = toMm(b.quantity)
    else if (b.bucket === 'cap') inv.caps[b.material_id] = Math.round(num(b.quantity))
  }
  for (const o of offcuts) {
    if (o.status !== 'available') continue
    ;(inv.offcuts[o.material_id] ??= []).push({ id: o.id, lengthMm: toMm(o.length) })
  }
  for (const k of Object.keys(inv.offcuts)) inv.offcuts[k].sort((a, b) => a.lengthMm - b.lengthMm || a.id.localeCompare(b.id))
  return inv
}

export { num as toNumber }
