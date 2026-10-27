import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Lang } from '../dbTypes'
import { en, type TKey } from './en'
import { vi } from './vi'

const DICT: Record<Lang, Record<TKey, string>> = { en, vi }
const LS_KEY = 'haic.lang'

type Params = Record<string, string | number>
export type TFn = (key: TKey, params?: Params) => string

interface Ctx {
  lang: Lang
  setLang: (l: Lang) => void
  t: TFn
}
const I18nContext = createContext<Ctx | null>(null)

function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(LS_KEY)
    if (v === 'vi' || v === 'en') return v
  } catch {
    /* storage unavailable */
  }
  return 'vi'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang)
  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem(LS_KEY, l) // UI preference only; never business data
    } catch {
      /* ignore */
    }
  }, [])
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  const t = useCallback<TFn>(
    (key, params) => {
      let s = DICT[lang][key] ?? DICT.en[key] ?? key
      if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v))
      return s
    },
    [lang],
  )
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext)
  if (!c) throw new Error('useI18n outside I18nProvider')
  return c
}

/** Translate a possibly-dynamic key; unknown keys fall back to the raw text. */
export function tryT(t: TFn, key: string, fallback?: string): string {
  return key in en ? t(key as TKey) : (fallback ?? key)
}
