import type { Lang } from './dbTypes'

export function fmtNum(n: number | null | undefined, digits = 3, lang: Lang = 'en'): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '-'
  const v = Math.round(n * 10 ** digits) / 10 ** digits
  return v.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US', { maximumFractionDigits: digits })
}
export const fmtM = (n: number | null | undefined, lang: Lang = 'en') => `${fmtNum(n, 3, lang)} m`

export function fmtDateTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })
}
export function fmtDate(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '-'
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00') : new Date(iso)
  return d.toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB')
}
export const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
