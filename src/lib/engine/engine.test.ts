import { describe, expect, it } from 'vitest'
import { calculate, planSignature, toRpcPlan } from './calculate'
import { formatMm, parseMetres } from './units'
import type { CalculationResult, EngineConfig, InventoryInput, LocationInput } from './types'

const CFG: EngineConfig = {
  stockLengthMm: 4000,
  cuttingAllowanceMm: 0,
  minOffcutMm: 0,
  allowJoints: true,
  types: {
    piezometer: { type: 'piezometer', pipeKey: 'D35', screenKey: 'S35', capKey: 'C35', projectionMm: 1000, defaultScreenMm: 1000 },
    permeability: { type: 'permeability', pipeKey: 'D35', screenKey: 'S35', capKey: 'C35', projectionMm: 1000, defaultScreenMm: 1000 },
    standpipe: { type: 'standpipe', pipeKey: 'D55', screenKey: 'S55', capKey: 'C55', projectionMm: 1000, defaultScreenMm: 5000 },
    seismic: { type: 'seismic', pipeKey: 'D90', screenKey: null, capKey: 'C90', projectionMm: 500, defaultScreenMm: 0 },
  },
}

const RICH: InventoryInput = {
  fullPipes: { D35: 1000, D55: 1000, D90: 1000 },
  offcuts: {},
  screensMm: { S35: 1_000_000, S55: 1_000_000 },
  caps: { C35: 1000, C55: 1000, C90: 1000 },
}

const inv = (patch: Partial<InventoryInput> = {}): InventoryInput => ({ ...RICH, ...patch })

function pipePlan(r: CalculationResult, key: string) {
  const p = r.pipePlans.find((x) => x.pipeKey === key)
  if (!p) throw new Error('no plan for ' + key)
  return p
}

/** Every mm must be accounted for and nothing may exceed its source piece. */
function assertInvariants(r: CalculationResult, cfg: EngineConfig, inventory: InventoryInput) {
  expect(r.ok).toBe(true)
  const generated = new Map<string, number>()
  const usedOffcuts = new Set<string>()
  for (const s of r.steps) {
    expect(s.cutMm).toBeGreaterThan(0)
    expect(s.cutMm).toBeLessThanOrEqual(s.sourceLengthMm)
    expect(s.sourceLengthMm).toBeLessThanOrEqual(cfg.stockLengthMm)
    expect(s.cutMm + s.leftoverMm + s.kerfMm + s.scrapMm).toBe(s.sourceLengthMm)
    if (s.source === 'stock') expect(s.sourceLengthMm).toBe(cfg.stockLengthMm)
    if (s.source === 'offcut') {
      expect(usedOffcuts.has(s.offcutId!)).toBe(false)
      usedOffcuts.add(s.offcutId!)
      const real = (inventory.offcuts[s.pipeKey] ?? []).find((o) => o.id === s.offcutId)
      expect(real?.lengthMm).toBe(s.sourceLengthMm)
    }
    if (s.source === 'generated') {
      expect(generated.get(s.sourceRef!)).toBe(s.sourceLengthMm)
      generated.delete(s.sourceRef!) // each leftover can be used once
    }
    if (s.leftoverMm > 0) {
      expect(s.leftoverRef).toBeTruthy()
      generated.set(s.leftoverRef!, s.leftoverMm)
    }
  }
  // per location: segments add up to exactly the required PVC length
  for (const loc of r.locations) {
    expect(loc.segmentsMm.reduce((a, b) => a + b, 0)).toBe(loc.pvcMm)
    expect(loc.totalMm).toBe(loc.depthMm + loc.projectionMm)
    expect(loc.totalMm).toBeGreaterThanOrEqual(loc.depthMm + loc.projectionMm)
  }
  // leftovers still in the pool == plan.generated
  for (const p of r.pipePlans) {
    const rawIn = p.rawNewMm + p.offcutsConsumedMm
    expect(rawIn).toBe(p.requiredMm + p.generatedMm + p.scrapMm + p.kerfMm)
    expect(p.unusedMm).toBe(p.generatedMm + p.scrapMm + p.kerfMm)
  }
}

describe('units', () => {
  it('parses metres to integer mm without float error', () => {
    expect(parseMetres('12.5')).toEqual({ ok: true, mm: 12500 })
    expect(parseMetres('12,5')).toEqual({ ok: true, mm: 12500 })
    expect(parseMetres(0.1 + 0.2)).toEqual({ ok: true, mm: 300 }) // float noise is tolerated
    expect(parseMetres(1.2345)).toEqual({ ok: false, reason: 'precision' })
    expect(parseMetres('1.234')).toEqual({ ok: true, mm: 1234 })
    expect(parseMetres('1.2345')).toEqual({ ok: false, reason: 'precision' })
    expect(parseMetres('1.2300')).toEqual({ ok: true, mm: 1230 })
    expect(parseMetres('')).toEqual({ ok: false, reason: 'empty' })
    expect(parseMetres('abc')).toEqual({ ok: false, reason: 'invalid' })
  })
  it('formats mm without rounding', () => {
    expect(formatMm(13500)).toBe('13.5')
    expect(formatMm(4000)).toBe('4')
    expect(formatMm(333)).toBe('0.333')
    expect(formatMm(20500)).toBe('20.5')
  })
})

describe('Acceptance tests (spec section 8)', () => {
  it('Test A - Piezometer 12.5 m, screen 1 m', () => {
    const r = calculate([{ type: 'piezometer', code: 'BH-01', depthM: 12.5 }], CFG, inv())
    assertInvariants(r, CFG, inv())
    expect(r.locations[0].totalMm).toBe(13500)
    expect(r.locations[0].pvcMm).toBe(12500)
    expect(r.locations[0].screenMm).toBe(1000)
    const p = pipePlan(r, 'D35')
    expect(p.newPipes).toBe(4)
    expect(p.rawNewMm).toBe(16000)
    expect(p.unusedMm).toBe(3500)
    expect(p.generated.map((g) => g.lengthMm)).toEqual([3500])
    expect(r.caps[0]).toMatchObject({ capKey: 'C35', top: 1, bottom: 1, total: 2 })
    expect(r.stock.find((s) => s.bucket === 'screen')?.required).toBe(1000)
  })

  it('Test B - Standpipe 18 m, screen 5 m', () => {
    const r = calculate([{ type: 'standpipe', code: 'SP-01', depthM: 18 }], CFG, inv())
    assertInvariants(r, CFG, inv())
    expect(r.locations[0].totalMm).toBe(19000)
    expect(r.locations[0].pvcMm).toBe(14000)
    expect(r.locations[0].screenMm).toBe(5000)
    const p = pipePlan(r, 'D55')
    expect(p.newPipes).toBe(4)
    expect(p.unusedMm).toBe(2000)
    expect(r.caps[0]).toMatchObject({ capKey: 'C55', top: 1, bottom: 1, total: 2 })
  })

  it('Test C - Permeability 10 m, screen 1 m', () => {
    const r = calculate([{ type: 'permeability', code: 'PM-01', depthM: 10 }], CFG, inv())
    assertInvariants(r, CFG, inv())
    expect(r.locations[0].totalMm).toBe(11000)
    expect(r.locations[0].pvcMm).toBe(10000)
    const p = pipePlan(r, 'D35')
    expect(p.newPipes).toBe(3)
    expect(p.unusedMm).toBe(2000)
    expect(r.caps[0].total).toBe(2)
  })

  it('Test D - Seismic 20 m, no screen', () => {
    const r = calculate([{ type: 'seismic', code: 'SM-01', depthM: 20 }], CFG, inv())
    assertInvariants(r, CFG, inv())
    expect(r.locations[0].totalMm).toBe(20500)
    expect(r.locations[0].pvcMm).toBe(20500)
    expect(r.locations[0].screenMm).toBe(0)
    const p = pipePlan(r, 'D90')
    expect(p.newPipes).toBe(6)
    expect(p.unusedMm).toBe(3500)
    expect(r.caps[0]).toMatchObject({ capKey: 'C90', total: 2 })
    expect(r.stock.some((s) => s.bucket === 'screen')).toBe(false)
  })
})

describe('Rules and validation', () => {
  it('uses defaults for projection and screen length per type', () => {
    const r = calculate(
      [
        { type: 'piezometer', code: 'a', depthM: 5 },
        { type: 'permeability', code: 'b', depthM: 5 },
        { type: 'standpipe', code: 'c', depthM: 5 },
        { type: 'seismic', code: 'd', depthM: 5 },
      ],
      CFG,
      inv(),
    )
    expect(r.locations.map((l) => [l.projectionMm, l.screenMm])).toEqual([
      [1000, 1000],
      [1000, 1000],
      [1000, 5000],
      [500, 0],
    ])
  })

  it('accepts a custom screen length and subtracts it from the PVC length', () => {
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 10, screenM: '2.5' }], CFG, inv())
    expect(r.locations[0].screenMm).toBe(2500)
    expect(r.locations[0].pvcMm).toBe(11000 - 2500)
    expect(r.stock.find((s) => s.bucket === 'screen')?.required).toBe(2500)
  })

  it('never produces a PVC length shorter than depth + projection - screen', () => {
    for (const d of [0.001, 0.5, 3.999, 4, 4.001, 7.77, 12.5, 99.999]) {
      const r = calculate([{ type: 'piezometer', code: 'x', depthM: d, screenM: 0 }], CFG, inv())
      if (!r.ok) continue
      const loc = r.locations[0]
      expect(loc.pvcMm).toBe(Math.round(d * 1000) + 1000)
      expect(loc.segmentsMm.reduce((a, b) => a + b, 0)).toBe(loc.pvcMm)
    }
  })

  it('blocks screen longer than total installed length', () => {
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 2, screenM: 3.5 }], CFG, inv())
    expect(r.ok).toBe(false)
    expect(r.issues.map((i) => i.code)).toContain('SCREEN_TOO_LONG')
    // exactly equal is allowed (no PVC needed)
    const eq = calculate([{ type: 'piezometer', code: 'a', depthM: 2, screenM: 3 }], CFG, inv())
    expect(eq.ok).toBe(true)
    expect(eq.locations[0].pvcMm).toBe(0)
    expect(eq.steps.length).toBe(0)
  })

  it('validates depth, screen, identifiers and duplicates', () => {
    const rows: LocationInput[] = [
      { type: 'piezometer', code: '', depthM: '5' },
      { type: 'piezometer', code: 'BH-1', depthM: '0' },
      { type: 'piezometer', code: 'bh-1 ', depthM: '-3' },
      { type: 'piezometer', code: 'BH-2', depthM: '' },
      { type: 'piezometer', code: 'BH-3', depthM: '5', screenM: '-1' },
      { type: 'piezometer', code: 'BH-4', depthM: '1.2345' },
      { type: 'seismic', code: 'SM-1', depthM: '5', screenM: '2' },
    ]
    const r = calculate(rows, CFG, inv())
    expect(r.ok).toBe(false)
    const codes = r.issues.map((i) => `${i.rowIndex}:${i.code}`)
    expect(codes).toContain('0:CODE_REQUIRED')
    expect(codes).toContain('1:CODE_DUPLICATE')
    expect(codes).toContain('2:CODE_DUPLICATE')
    expect(codes).toContain('1:DEPTH_NOT_POSITIVE')
    expect(codes).toContain('2:DEPTH_NOT_POSITIVE')
    expect(codes).toContain('3:DEPTH_REQUIRED')
    expect(codes).toContain('4:SCREEN_NEGATIVE')
    expect(codes).toContain('5:DEPTH_PRECISION')
    expect(codes).toContain('6:SCREEN_NOT_APPLICABLE')
    expect(r.canSave).toBe(false)
  })

  it('flags duplicate identifiers across different installation types of the same record', () => {
    const r = calculate(
      [
        { type: 'piezometer', code: 'BH-01', depthM: 5 },
        { type: 'seismic', code: 'BH-01', depthM: 5 },
      ],
      CFG,
      inv(),
    )
    expect(r.issues.filter((i) => i.code === 'CODE_DUPLICATE').length).toBe(2)
  })

  it('empty location list is rejected', () => {
    expect(calculate([], CFG, inv()).issues[0].code).toBe('NO_LOCATIONS')
  })
})

describe('Multiple locations, offcut reuse and cutting plans', () => {
  it('three piezometers: 6 D35 caps (3 top + 3 bottom) and offcuts reused between locations', () => {
    const locs: LocationInput[] = [
      { type: 'piezometer', code: 'BH-01', depthM: 12.5 },
      { type: 'piezometer', code: 'BH-02', depthM: 15 },
      { type: 'piezometer', code: 'BH-03', depthM: 8 },
    ]
    const r = calculate(locs, CFG, inv())
    assertInvariants(r, CFG, inv())
    expect(r.caps[0]).toMatchObject({ top: 3, bottom: 3, total: 6 })
    // PVC: 12.5 + 15 + 8 = 35.5 m  -> at least ceil(35.5/4) = 9 pipes, and joints allow exactly 9
    const p = pipePlan(r, 'D35')
    expect(p.requiredMm).toBe(35500)
    expect(p.newPipes).toBe(9)
    expect(p.unusedMm).toBe(9 * 4000 - 35500)
    // raw material is conserved
    expect(p.rawNewMm).toBe(p.requiredMm + p.generatedMm + p.scrapMm + p.kerfMm)
  })

  it('reuses existing offcuts of the SAME diameter before cutting new pipes', () => {
    const offcuts = { D35: [{ id: 'o1', lengthMm: 2500 }, { id: 'o2', lengthMm: 1000 }] }
    const i = inv({ offcuts })
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 12.5 }], CFG, i)
    assertInvariants(r, CFG, i)
    const p = pipePlan(r, 'D35')
    // required 12.5 m; offcuts give 3.5 m, so 9.0 m must come from new pipes => 3 pipes (12 m), 3 m unused
    expect(p.offcutsConsumed.map((o) => o.id).sort()).toEqual(['o1', 'o2'])
    expect(p.newPipes).toBe(3)
    expect(p.generatedMm).toBe(3000)
    expect(r.offcutLines[0]).toMatchObject({ beforeCount: 2, beforeMm: 3500, consumedCount: 2, consumedMm: 3500, generatedCount: 1, generatedMm: 3000, afterCount: 1, afterMm: 3000 })
  })

  it('never uses offcuts of another diameter', () => {
    const i = inv({ offcuts: { D55: [{ id: 'x', lengthMm: 3900 }], D90: [{ id: 'y', lengthMm: 3900 }] } })
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 3 }], CFG, i)
    assertInvariants(r, CFG, i)
    expect(r.steps.every((s) => s.pipeKey === 'D35' && s.source !== 'offcut')).toBe(true)
  })

  it('best-fit: a short requirement is cut from the smallest offcut that covers it', () => {
    const i = inv({ offcuts: { D35: [{ id: 'big', lengthMm: 3900 }, { id: 'fit', lengthMm: 1500 }, { id: 'tiny', lengthMm: 200 }] } })
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 0.5, screenM: 0 }], CFG, i) // pvc = 1.5 m
    assertInvariants(r, CFG, i)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0]).toMatchObject({ source: 'offcut', offcutId: 'fit', cutMm: 1500, leftoverMm: 0 })
    expect(r.pipePlans[0].newPipes).toBe(0)
  })

  it('leftover from one location is reused by the next location within the same calculation', () => {
    const r = calculate(
      [
        { type: 'piezometer', code: 'A', depthM: 2.5 }, // pvc 2.5 -> new pipe, leftover 1.5
        { type: 'piezometer', code: 'B', depthM: 0.5, screenM: 0 }, // pvc 1.5 -> reuses leftover exactly
      ],
      CFG,
      inv(),
    )
    assertInvariants(r, CFG, inv())
    const p = pipePlan(r, 'D35')
    expect(p.newPipes).toBe(1)
    expect(p.generated).toHaveLength(0)
    expect(p.unusedMm).toBe(0)
    expect(r.steps.some((s) => s.source === 'generated')).toBe(true)
  })

  it('tracks individual leftover pieces, never merging them into one length', () => {
    const r = calculate(
      [
        { type: 'piezometer', code: 'A', depthM: 1.5 }, // pvc 1.5 -> leftover 2.5
        { type: 'piezometer', code: 'B', depthM: 2, screenM: 0 }, // pvc 3.0 -> cannot use 2.5 alone
      ],
      CFG,
      inv(),
    )
    assertInvariants(r, CFG, inv())
    for (const g of pipePlan(r, 'D35').generated) expect(g.lengthMm).toBeLessThanOrEqual(4000)
  })

  it('mixes installation types of the same diameter in one pipe plan but keeps type summaries separate', () => {
    const r = calculate(
      [
        { type: 'piezometer', code: 'P1', depthM: 4 },
        { type: 'permeability', code: 'K1', depthM: 4 },
        { type: 'seismic', code: 'S1', depthM: 4 },
      ],
      CFG,
      inv(),
    )
    assertInvariants(r, CFG, inv())
    expect(r.pipePlans.map((p) => p.pipeKey).sort()).toEqual(['D35', 'D90'])
    expect(r.byType.map((t) => t.type)).toEqual(['piezometer', 'permeability', 'seismic'])
    expect(r.caps.map((c) => [c.capKey, c.total]).sort()).toEqual([['C35', 4], ['C90', 2]])
  })

  it('does not double count: caps, screens and pipes are separate stock lines', () => {
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 12.5 }], CFG, inv())
    const keys = r.stock.map((s) => `${s.key}:${s.bucket}`).sort()
    expect(keys).toEqual(['C35:cap', 'D35:full', 'S35:screen'])
  })

  it('respects a no-joint policy (single piece per installation)', () => {
    const cfg = { ...CFG, allowJoints: false }
    const bad = calculate([{ type: 'piezometer', code: 'a', depthM: 12.5 }], cfg, inv())
    expect(bad.ok).toBe(false)
    expect(bad.issues[0].code).toBe('JOINT_REQUIRED')
    const ok = calculate([{ type: 'piezometer', code: 'a', depthM: 1.5 }], cfg, inv())
    assertInvariants(ok, cfg, inv())
    expect(ok.steps).toHaveLength(1)
  })

  it('applies an enabled cutting allowance (kerf) and still accounts for every millimetre', () => {
    const cfg = { ...CFG, cuttingAllowanceMm: 3 }
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 12.5 }], cfg, inv())
    assertInvariants(r, cfg, inv())
    const p = pipePlan(r, 'D35')
    expect(p.kerfMm).toBe(3)
    expect(p.generatedMm).toBe(3500 - 3)
    expect(p.newPipes).toBe(4)
  })

  it('turns remainders below the minimum reusable length into scrap, not offcuts', () => {
    const cfg = { ...CFG, minOffcutMm: 500 }
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 2.6, screenM: 0 }], cfg, inv()) // pvc 3.6 -> remainder 0.4
    assertInvariants(r, cfg, inv())
    const p = pipePlan(r, 'D35')
    expect(p.generated).toHaveLength(0)
    expect(p.scrapMm).toBe(400)
  })
})

describe('Inventory checks (calculate previews, never deducts)', () => {
  it('reports exact shortages by material and blocks saving', () => {
    const i = inv({ fullPipes: { D35: 2, D55: 10, D90: 10 }, screensMm: { S35: 500, S55: 0 }, caps: { C35: 1, C55: 2, C90: 2 } })
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 12.5 }], CFG, i)
    expect(r.ok).toBe(true)
    expect(r.canSave).toBe(false)
    const miss = Object.fromEntries(r.shortages.map((s) => [`${s.key}:${s.bucket}`, s.missing]))
    expect(miss).toEqual({ 'D35:full': 2, 'S35:screen': 500, 'C35:cap': 1 })
  })

  it('does not mutate the inventory object passed in', () => {
    const i = inv({ offcuts: { D35: [{ id: 'o1', lengthMm: 2500 }] } })
    const snapshot = JSON.stringify(i)
    calculate([{ type: 'piezometer', code: 'a', depthM: 12.5 }], CFG, i)
    expect(JSON.stringify(i)).toBe(snapshot)
  })

  it('projects remaining inventory', () => {
    const i = inv({ fullPipes: { D35: 10, D55: 0, D90: 0 }, screensMm: { S35: 5000, S55: 0 }, caps: { C35: 4, C55: 0, C90: 0 } })
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 12.5 }], CFG, i)
    const by = Object.fromEntries(r.stock.map((s) => [s.bucket, s]))
    expect(by.full).toMatchObject({ available: 10, required: 4, after: 6 })
    expect(by.screen).toMatchObject({ available: 5000, required: 1000, after: 4000 })
    expect(by.cap).toMatchObject({ available: 4, required: 2, after: 2 })
  })

  it('produces an RPC plan in metres and a stable signature', () => {
    const r = calculate([{ type: 'piezometer', code: 'a', depthM: 12.5 }], CFG, inv())
    const plan = toRpcPlan(r)
    expect(plan[0]).toMatchObject({ step: 1, location: 0, source: 'stock', source_length: 4, cut_length: 4 })
    expect(planSignature(r)).toBe(planSignature(calculate([{ type: 'piezometer', code: 'a', depthM: 12.5 }], CFG, inv())))
    const changed = calculate([{ type: 'piezometer', code: 'a', depthM: 12.5 }], CFG, inv({ fullPipes: { D35: 3, D55: 1, D90: 1 } }))
    expect(planSignature(changed)).not.toBe(planSignature(r))
  })
})

describe('Randomised invariants (seeded)', () => {
  function rng(seed: number) {
    let s = seed
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296
      return s / 4294967296
    }
  }
  it('conserves material and never over-cuts for 300 random jobs', () => {
    const rand = rng(12345)
    const types = ['piezometer', 'permeability', 'standpipe', 'seismic'] as const
    for (let n = 0; n < 300; n++) {
      const count = 1 + Math.floor(rand() * 6)
      const locs: LocationInput[] = []
      for (let i = 0; i < count; i++) {
        locs.push({
          type: types[Math.floor(rand() * 4)],
          code: `L${i}`,
          depthM: (Math.floor(rand() * 40000) + 100) / 1000,
        })
      }
      const offN = Math.floor(rand() * 5)
      const offcuts: InventoryInput['offcuts'] = { D35: [], D55: [], D90: [] }
      for (let k = 0; k < offN; k++) {
        const key = ['D35', 'D55', 'D90'][Math.floor(rand() * 3)]
        offcuts[key].push({ id: `o${n}-${k}`, lengthMm: 100 + Math.floor(rand() * 3800) })
      }
      const cfg: EngineConfig = {
        ...CFG,
        cuttingAllowanceMm: rand() < 0.3 ? 3 : 0,
        minOffcutMm: rand() < 0.3 ? 200 : 0,
      }
      const i = inv({ offcuts })
      const r = calculate(locs, cfg, i)
      if (!r.ok) continue // e.g. screen longer than total
      assertInvariants(r, cfg, i)
      // lower bound on new pipes: total required minus offcut length, in pipes
      for (const p of r.pipePlans) {
        const offTotal = (offcuts[p.pipeKey] ?? []).reduce((s, o) => s + o.lengthMm, 0)
        const lower = Math.max(0, Math.ceil((p.requiredMm - offTotal) / 4000))
        expect(p.newPipes).toBeGreaterThanOrEqual(lower)
      }
    }
  })
})
