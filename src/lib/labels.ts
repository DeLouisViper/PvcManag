import type { InstallationType } from './engine'
import type { Lang, Material } from './dbTypes'
import type { TFn } from './i18n'
import type { TKey } from './i18n/en'

export const matName = (m: Pick<Material, 'name' | 'name_vi'> | undefined, lang: Lang): string =>
  !m ? '?' : lang === 'vi' && m.name_vi ? m.name_vi : m.name

export const typeShort = (t: TFn, ty: InstallationType) => t(`it.${ty}` as TKey)
export const typeFull = (t: TFn, ty: InstallationType) => t(`it.${ty}.full` as TKey)

export const bucketLabel = (t: TFn, b: string) => t(`tx.bucket.${b}` as TKey)

/** Translate an engine / database failure into a user message. */
export function issueText(t: TFn, code: string, params?: Record<string, string | number>): string {
  return t(`err.${code}` as TKey, params)
}

export const TYPE_COLORS: Record<InstallationType, string> = {
  piezometer: '#ff8a1f',
  standpipe: '#52c4b0',
  permeability: '#ffb54a',
  seismic: '#ff5a43',
}
