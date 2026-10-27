import { planPipe, type PipeRequirement } from './cutting'
import { parseMetres } from './units'
import type {
  CalculationResult,
  CapSummary,
  EngineConfig,
  InstallationType,
  InventoryInput,
  LocationInput,
  LocationResult,
  OffcutLine,
  PipePlan,
  PlanStep,
  StockLine,
  TypeSummary,
  ValidationIssue,
} from './types'
import { INSTALLATION_TYPES } from './types'

function emptyResult(issues: ValidationIssue[]): CalculationResult {
  return {
    ok: false,
    issues,
    locations: [],
    byType: [],
    pipePlans: [],
    caps: [],
    stock: [],
    offcutLines: [],
    shortages: [],
    steps: [],
    totalInstalledMm: 0,
    canSave: false,
  }
}

/** Validate the configuration itself (never trust it blindly). */
function configIssues(cfg: EngineConfig): ValidationIssue[] {
  const bad = (msg: string): ValidationIssue => ({ rowIndex: null, field: 'general', code: 'CONFIG_INVALID', params: { msg } })
  const out: ValidationIssue[] = []
  if (!Number.isInteger(cfg.stockLengthMm) || cfg.stockLengthMm <= 0) out.push(bad('stock length'))
  if (!Number.isInteger(cfg.cuttingAllowanceMm) || cfg.cuttingAllowanceMm < 0) out.push(bad('cutting allowance'))
  if (!Number.isInteger(cfg.minOffcutMm) || cfg.minOffcutMm < 0) out.push(bad('minimum offcut'))
  for (const t of INSTALLATION_TYPES) {
    const c = cfg.types[t]
    if (!c) out.push(bad(`type ${t}`))
    else if (c.projectionMm < 0 || c.defaultScreenMm < 0) out.push(bad(`type ${t} values`))
  }
  return out
}

/**
 * Pure calculation of every material requirement for a set of installation locations.
 * Never touches the database and never deducts stock: it only PREVIEWS what saving would do.
 *
 *   total installed length = depth + above-ground projection
 *   PVC length             = total installed length - screen length   (screen is part of the assembly)
 *   caps                   = 1 top + 1 bottom per location
 */
export function calculate(locations: LocationInput[], cfg: EngineConfig, inv: InventoryInput): CalculationResult {
  const cfgIssues = configIssues(cfg)
  if (cfgIssues.length) return emptyResult(cfgIssues)
  if (locations.length === 0) return emptyResult([{ rowIndex: null, field: 'general', code: 'NO_LOCATIONS' }])

  const issues: ValidationIssue[] = []
  const results: LocationResult[] = []

  // duplicate identifiers across the whole record (case-insensitive)
  const seen = new Map<string, number[]>()
  locations.forEach((l, i) => {
    const k = l.code.trim().toLowerCase()
    if (k) seen.set(k, [...(seen.get(k) ?? []), i])
  })

  locations.forEach((loc, i) => {
    const tc = cfg.types[loc.type]
    const code = loc.code.trim()
    if (!code) issues.push({ rowIndex: i, field: 'code', code: 'CODE_REQUIRED' })
    else if ((seen.get(code.toLowerCase()) ?? []).length > 1)
      issues.push({ rowIndex: i, field: 'code', code: 'CODE_DUPLICATE', params: { code } })

    const d = parseMetres(loc.depthM)
    let depthMm = 0
    if (!d.ok) {
      issues.push({
        rowIndex: i,
        field: 'depth',
        code: d.reason === 'empty' ? 'DEPTH_REQUIRED' : d.reason === 'precision' ? 'DEPTH_PRECISION' : 'DEPTH_NOT_POSITIVE',
      })
    } else if (d.mm <= 0) {
      issues.push({ rowIndex: i, field: 'depth', code: 'DEPTH_NOT_POSITIVE' })
    } else depthMm = d.mm

    let screenMm = tc.defaultScreenMm
    const hasOverride = loc.screenM !== null && loc.screenM !== undefined && String(loc.screenM).trim() !== ''
    if (tc.screenKey === null) {
      screenMm = 0
      if (hasOverride) {
        const s = parseMetres(loc.screenM)
        if (!s.ok || s.mm !== 0) issues.push({ rowIndex: i, field: 'screen', code: 'SCREEN_NOT_APPLICABLE' })
      }
    } else if (hasOverride) {
      const s = parseMetres(loc.screenM)
      if (!s.ok) issues.push({ rowIndex: i, field: 'screen', code: s.reason === 'precision' ? 'SCREEN_PRECISION' : 'SCREEN_NEGATIVE' })
      else if (s.mm < 0) issues.push({ rowIndex: i, field: 'screen', code: 'SCREEN_NEGATIVE' })
      else screenMm = s.mm
    }

    const totalMm = depthMm + tc.projectionMm
    if (depthMm > 0 && screenMm > totalMm) {
      issues.push({
        rowIndex: i,
        field: 'screen',
        code: 'SCREEN_TOO_LONG',
        params: { screen: screenMm / 1000, total: totalMm / 1000 },
      })
    }
    results.push({
      index: i,
      type: loc.type,
      code,
      depthMm,
      projectionMm: tc.projectionMm,
      screenMm,
      totalMm,
      pvcMm: Math.max(0, totalMm - screenMm),
      topCaps: 1,
      bottomCaps: 1,
      pipeKey: tc.pipeKey,
      screenKey: tc.screenKey,
      capKey: tc.capKey,
      segmentsMm: [],
    })
  })

  if (issues.length) return { ...emptyResult(issues), locations: results }

  // ---- cutting plans, one per pipe diameter (pipe key) ----
  const pipeKeys: string[] = []
  for (const r of results) if (!pipeKeys.includes(r.pipeKey)) pipeKeys.push(r.pipeKey)

  const pipePlans: PipePlan[] = []
  let globalStep = 0
  const steps: PlanStep[] = []
  pipeKeys.forEach((pipeKey, pi) => {
    const reqs: PipeRequirement[] = results
      .filter((r) => r.pipeKey === pipeKey)
      .map((r) => ({ locationIndex: r.index, pvcMm: r.pvcMm }))
    const plan = planPipe(pipeKey, `P${pi}`, reqs, inv.offcuts[pipeKey] ?? [], cfg)
    if ('error' in plan) {
      issues.push({ rowIndex: plan.locationIndex, field: 'depth', code: 'JOINT_REQUIRED', params: { stock: cfg.stockLengthMm / 1000 } })
      return
    }
    plan.steps = plan.steps.map((s) => ({ ...s, step: ++globalStep }))
    pipePlans.push(plan)
    steps.push(...plan.steps)
  })
  if (issues.length) return { ...emptyResult(issues), locations: results }

  // segments per location
  for (const s of steps) results[s.locationIndex].segmentsMm.push(s.cutMm)

  // ---- per type summaries ----
  const byType: TypeSummary[] = []
  for (const t of INSTALLATION_TYPES) {
    const rows = results.filter((r) => r.type === t)
    if (!rows.length) continue
    byType.push({
      type: t as InstallationType,
      locations: rows.length,
      depthMm: rows.reduce((s, r) => s + r.depthMm, 0),
      totalMm: rows.reduce((s, r) => s + r.totalMm, 0),
      pvcMm: rows.reduce((s, r) => s + r.pvcMm, 0),
      screenMm: rows.reduce((s, r) => s + r.screenMm, 0),
      topCaps: rows.length,
      bottomCaps: rows.length,
    })
  }

  // ---- caps ----
  const capMap = new Map<string, CapSummary>()
  for (const r of results) {
    const c = capMap.get(r.capKey) ?? { capKey: r.capKey, top: 0, bottom: 0, total: 0 }
    c.top += 1
    c.bottom += 1
    c.total += 2
    capMap.set(r.capKey, c)
  }
  const caps = [...capMap.values()]

  // ---- stock lines ----
  const stock: StockLine[] = []
  const line = (key: string, bucket: StockLine['bucket'], unit: StockLine['unit'], required: number, available: number): StockLine => ({
    key,
    bucket,
    unit,
    required,
    available,
    after: available - required,
    missing: Math.max(0, required - available),
  })
  for (const p of pipePlans) stock.push(line(p.pipeKey, 'full', 'pcs', p.newPipes, inv.fullPipes[p.pipeKey] ?? 0))
  const screenReq = new Map<string, number>()
  for (const r of results) if (r.screenKey && r.screenMm > 0) screenReq.set(r.screenKey, (screenReq.get(r.screenKey) ?? 0) + r.screenMm)
  for (const [k, v] of screenReq) stock.push(line(k, 'screen', 'mm', v, inv.screensMm[k] ?? 0))
  for (const c of caps) stock.push(line(c.capKey, 'cap', 'pcs', c.total, inv.caps[c.capKey] ?? 0))

  const offcutLines: OffcutLine[] = pipePlans.map((p) => {
    const list = inv.offcuts[p.pipeKey] ?? []
    const beforeMm = list.reduce((s, o) => s + o.lengthMm, 0)
    return {
      pipeKey: p.pipeKey,
      beforeCount: list.length,
      beforeMm,
      consumedCount: p.offcutsConsumed.length,
      consumedMm: p.offcutsConsumedMm,
      generatedCount: p.generated.length,
      generatedMm: p.generatedMm,
      afterCount: list.length - p.offcutsConsumed.length + p.generated.length,
      afterMm: beforeMm - p.offcutsConsumedMm + p.generatedMm,
    }
  })

  const shortages = stock.filter((s) => s.missing > 0)
  return {
    ok: true,
    issues: [],
    locations: results,
    byType,
    pipePlans,
    caps,
    stock,
    offcutLines,
    shortages,
    steps,
    totalInstalledMm: results.reduce((s, r) => s + r.totalMm, 0),
    canSave: shortages.length === 0,
  }
}

/** Payload sent to the database function `save_installation` (lengths in metres). */
export function toRpcPlan(result: CalculationResult) {
  return result.steps.map((s) => ({
    step: s.step,
    location: s.locationIndex,
    source: s.source,
    offcut_id: s.offcutId,
    source_ref: s.sourceRef,
    source_length: s.sourceLengthMm / 1000,
    cut_length: s.cutMm / 1000,
    leftover_ref: s.leftoverRef,
  }))
}

/** Stable fingerprint used to detect that the inventory changed between preview and save. */
export function planSignature(result: CalculationResult): string {
  return JSON.stringify([
    result.steps.map((s) => [s.step, s.locationIndex, s.source, s.offcutId, s.sourceRef, s.sourceLengthMm, s.cutMm, s.leftoverRef]),
    result.stock.map((s) => [s.key, s.bucket, s.required, s.available]),
  ])
}
