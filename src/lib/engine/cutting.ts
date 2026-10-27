import type { EngineConfig, GeneratedOffcut, OffcutInput, PipePlan, PlanStep } from './types'

/**
 * Cutting-stock planner for ONE pipe diameter.
 *
 * Rules
 *  - every new pipe has the standard stock length (default 4 m)
 *  - existing offcuts of the same diameter are used before cutting new pipes
 *  - a leftover created by one cut is immediately available for the next location (reuse inside one calculation)
 *  - several segments may be joined to reach the required length when `allowJoints` is true
 *  - no segment is ever longer than the piece it is cut from
 *  - every millimetre is accounted for: source = cut + leftover + kerf + scrap
 *
 * The planner tries several deterministic strategies (location order x single-piece preference)
 * and keeps the plan with the fewest new pipes, then the fewest segments (joints), then the least scrap.
 */

export interface PipeRequirement {
  locationIndex: number
  pvcMm: number
}

/** Deterministic remainder rule - also re-implemented (and enforced) in the database function. */
export function splitRemainder(
  sourceMm: number,
  cutMm: number,
  cfg: Pick<EngineConfig, 'cuttingAllowanceMm' | 'minOffcutMm'>,
): { kerfMm: number; leftoverMm: number; scrapMm: number } {
  if (cutMm === sourceMm) return { kerfMm: 0, leftoverMm: 0, scrapMm: 0 }
  const rem = sourceMm - cutMm
  const kerfMm = Math.min(cfg.cuttingAllowanceMm, rem)
  const r2 = rem - kerfMm
  if (r2 > 0 && r2 >= cfg.minOffcutMm) return { kerfMm, leftoverMm: r2, scrapMm: 0 }
  return { kerfMm, leftoverMm: 0, scrapMm: r2 }
}

interface Piece {
  kind: 'offcut' | 'generated'
  id: string | null
  ref: string | null
  len: number
}

interface Attempt {
  steps: Omit<PlanStep, 'step'>[]
  pool: Piece[]
  newPipes: number
  scrapMm: number
  kerfMm: number
}

type Policy = 'pool-first' | 'single-piece-first'

function runAttempt(
  pipeKey: string,
  refPrefix: string,
  order: PipeRequirement[],
  offcuts: OffcutInput[],
  cfg: EngineConfig,
  policy: Policy,
): Attempt | { error: 'JOINT_REQUIRED'; locationIndex: number } {
  let pool: Piece[] = offcuts.map((o) => ({ kind: 'offcut', id: o.id, ref: null, len: o.lengthMm }))
  const steps: Omit<PlanStep, 'step'>[] = []
  let genCounter = 0
  let newPipes = 0
  let scrapMm = 0
  let kerfMm = 0
  const stock = cfg.stockLengthMm

  const emit = (
    locationIndex: number,
    source: 'stock' | 'offcut' | 'generated',
    piece: Piece | null,
    sourceLen: number,
    cut: number,
  ) => {
    const rem = splitRemainder(sourceLen, cut, cfg)
    let leftoverRef: string | null = null
    if (piece) pool = pool.filter((p) => p !== piece)
    if (rem.leftoverMm > 0) {
      genCounter += 1
      leftoverRef = `${refPrefix}-G${genCounter}`
      pool.push({ kind: 'generated', id: null, ref: leftoverRef, len: rem.leftoverMm })
    }
    if (source === 'stock') newPipes += 1
    scrapMm += rem.scrapMm
    kerfMm += rem.kerfMm
    steps.push({
      pipeKey,
      locationIndex,
      source,
      offcutId: piece && piece.kind === 'offcut' ? piece.id : null,
      sourceRef: piece && piece.kind === 'generated' ? piece.ref : null,
      sourceLengthMm: sourceLen,
      cutMm: cut,
      leftoverMm: rem.leftoverMm,
      kerfMm: rem.kerfMm,
      scrapMm: rem.scrapMm,
      leftoverRef,
    })
  }

  for (const req of order) {
    let remaining = req.pvcMm
    let segs = 0
    while (remaining > 0) {
      const covering = pool.filter((p) => p.len >= remaining)
      if (covering.length > 0) {
        // exact fit first, otherwise best fit (smallest piece that is long enough); stable on ties
        const exact = covering.find((p) => p.len === remaining)
        const piece = exact ?? covering.reduce((a, b) => (b.len < a.len ? b : a))
        emit(req.locationIndex, piece.kind === 'offcut' ? 'offcut' : 'generated', piece, piece.len, remaining)
        remaining = 0
      } else if (!cfg.allowJoints) {
        if (remaining <= stock) {
          emit(req.locationIndex, 'stock', null, stock, remaining)
          remaining = 0
        } else {
          return { error: 'JOINT_REQUIRED', locationIndex: req.locationIndex }
        }
      } else if (pool.length > 0 && !(policy === 'single-piece-first' && remaining <= stock)) {
        // nothing long enough: consume the longest remaining piece completely and keep going
        const piece = pool.reduce((a, b) => (b.len > a.len ? b : a))
        emit(req.locationIndex, piece.kind === 'offcut' ? 'offcut' : 'generated', piece, piece.len, piece.len)
        remaining -= piece.len
      } else if (remaining >= stock) {
        emit(req.locationIndex, 'stock', null, stock, stock)
        remaining -= stock
      } else {
        emit(req.locationIndex, 'stock', null, stock, remaining)
        remaining = 0
      }
      segs += 1
      if (segs > 10000) throw new Error('cutting planner runaway')
    }
  }
  return { steps, pool, newPipes, scrapMm, kerfMm }
}

function orderings(reqs: PipeRequirement[]): PipeRequirement[][] {
  const input = reqs.slice()
  const desc = reqs.slice().sort((a, b) => b.pvcMm - a.pvcMm || a.locationIndex - b.locationIndex)
  const asc = reqs.slice().sort((a, b) => a.pvcMm - b.pvcMm || a.locationIndex - b.locationIndex)
  return [desc, input, asc]
}

export function planPipe(
  pipeKey: string,
  refPrefix: string,
  reqs: PipeRequirement[],
  offcuts: OffcutInput[],
  cfg: EngineConfig,
): PipePlan | { error: 'JOINT_REQUIRED'; locationIndex: number } {
  const real = reqs.filter((r) => r.pvcMm > 0)
  const requiredMm = real.reduce((s, r) => s + r.pvcMm, 0)
  let best: Attempt | null = null
  let firstError: { error: 'JOINT_REQUIRED'; locationIndex: number } | null = null
  const policies: Policy[] = ['pool-first', 'single-piece-first']
  for (const order of orderings(real)) {
    for (const policy of policies) {
      const a = runAttempt(pipeKey, refPrefix, order, offcuts, cfg, policy)
      if ('error' in a) {
        firstError = firstError ?? a
        continue
      }
      if (
        !best ||
        a.newPipes < best.newPipes ||
        (a.newPipes === best.newPipes && a.steps.length < best.steps.length) ||
        (a.newPipes === best.newPipes && a.steps.length === best.steps.length && a.scrapMm < best.scrapMm)
      ) {
        best = a
      }
    }
  }
  if (!best) return firstError ?? { error: 'JOINT_REQUIRED', locationIndex: real[0]?.locationIndex ?? 0 }

  const steps: PlanStep[] = best.steps.map((s, i) => ({ ...s, step: i + 1 }))
  const consumedOffcuts: OffcutInput[] = []
  for (const s of steps) {
    if (s.source === 'offcut' && s.offcutId) consumedOffcuts.push({ id: s.offcutId, lengthMm: s.sourceLengthMm })
  }
  const generated: GeneratedOffcut[] = best.pool
    .filter((p) => p.kind === 'generated')
    .map((p) => ({ ref: p.ref as string, lengthMm: p.len }))
  const generatedMm = generated.reduce((s, g) => s + g.lengthMm, 0)
  const newPipes = best.newPipes
  const segmentsTotal = steps.length
  return {
    pipeKey,
    requiredMm,
    steps,
    newPipes,
    rawNewMm: newPipes * cfg.stockLengthMm,
    offcutsConsumed: consumedOffcuts,
    offcutsConsumedMm: consumedOffcuts.reduce((s, o) => s + o.lengthMm, 0),
    generated,
    generatedMm,
    scrapMm: best.scrapMm,
    kerfMm: best.kerfMm,
    unusedMm: generatedMm + best.scrapMm + best.kerfMm,
    joints: Math.max(0, segmentsTotal - real.length),
  }
}
