/** Metre <-> millimetre helpers. Everything the engine stores is integer mm. */

export type ParseResult = { ok: true; mm: number } | { ok: false; reason: 'empty' | 'invalid' | 'precision' }

/** Parse a user typed metre value ("12.5", "12,5", 12.5) into integer millimetres (max 3 decimals). */
export function parseMetres(input: string | number | null | undefined): ParseResult {
  if (input === null || input === undefined) return { ok: false, reason: 'empty' }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, reason: 'invalid' }
    const mm = Math.round(input * 1000)
    if (Math.abs(input * 1000 - mm) > 1e-6) return { ok: false, reason: 'precision' }
    return { ok: true, mm }
  }
  const s = input.trim().replace(',', '.')
  if (s === '') return { ok: false, reason: 'empty' }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, reason: 'invalid' }
  const [intPart, frac = ''] = s.split('.')
  if (frac.length > 3) {
    // allow trailing zeros beyond 3 decimals (e.g. 12.5000) but nothing else
    if (/[1-9]/.test(frac.slice(3))) return { ok: false, reason: 'precision' }
  }
  const neg = intPart.startsWith('-')
  const absInt = intPart.replace('-', '')
  const mm = parseInt(absInt, 10) * 1000 + parseInt((frac + '000').slice(0, 3), 10)
  return { ok: true, mm: neg ? -mm : mm }
}

/** mm -> metres as a JS number (exact for any value with <= 3 decimals). */
export function mmToM(mm: number): number {
  return mm / 1000
}

/** mm -> "13.5" / "0.333" / "4" (no trailing zeros, never rounds). */
export function formatMm(mm: number): string {
  const neg = mm < 0
  const a = Math.abs(mm)
  const whole = Math.floor(a / 1000)
  const frac = a % 1000
  const f = frac === 0 ? '' : '.' + String(frac).padStart(3, '0').replace(/0+$/, '')
  return (neg ? '-' : '') + whole + f
}
