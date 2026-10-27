import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type Kind = 'ok' | 'err' | 'warn'
interface ToastItem { id: number; kind: Kind; text: string }
interface Ctx { push: (kind: Kind, text: string) => void }
const ToastCtx = createContext<Ctx | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)
  const push = useCallback((kind: Kind, text: string) => {
    const id = ++seq.current
    setItems((x) => [...x.slice(-3), { id, kind, text }])
    window.setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'err' ? 9000 : 5000)
  }, [])
  const value = useMemo(() => ({ push }), [push])
  const color = { ok: 'border-tva-teal text-tva-teal shadow-tva-glow-teal', err: 'border-tva-red text-tva-red shadow-tva-glow-red', warn: 'border-tva-amber text-tva-amber shadow-tva-glow' }
  const mark = { ok: '[ OK ]', err: '[ ERR ]', warn: '[ WARN ]' }
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="fixed bottom-3 right-3 z-[70] flex w-[min(92vw,26rem)] flex-col gap-2" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} role={i.kind === 'err' ? 'alert' : 'status'} className={`animate-boot border-2 bg-tva-dark px-3 py-2 text-sm ${color[i.kind]}`}>
            <span className="mr-2 font-bold">{mark[i.kind]}</span>
            <span className="text-tva-cream">{i.text}</span>
            <button className="float-right ml-2 text-tva-sand hover:text-tva-cream" onClick={() => setItems((x) => x.filter((y) => y.id !== i.id))} aria-label="close">x</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export function useToast(): Ctx {
  const c = useContext(ToastCtx)
  if (!c) throw new Error('useToast outside provider')
  return c
}
