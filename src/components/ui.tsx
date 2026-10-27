import { useEffect, useId, type ReactNode } from 'react'
import { useI18n } from '../lib/i18n'

export function Panel({ title, right, children, className = '', bodyClass = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`panel ${className}`}>
      {title !== undefined && (
        <header className="panel-hd">
          <span className="flex items-center gap-2"><span className="inline-block h-2 w-2 bg-tva-orange shadow-tva-glow" />{title}</span>
          {right}
        </header>
      )}
      <div className={`panel-bd ${bodyClass}`}>{children}</div>
    </section>
  )
}

export function PageTitle({ children, sub, right }: { children: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b-4 border-tva-brown pb-2">
      <div>
        <h1 className="glow-text text-xl font-bold uppercase tracking-widest text-tva-orange sm:text-2xl">{children}</h1>
        {sub && <p className="mt-1 text-xs text-tva-sand">{sub}</p>}
      </div>
      {right}
    </div>
  )
}

export function Field({ label, children, error, hint }: { label: ReactNode; children: ReactNode; error?: string | null; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && !error && <span className="mt-0.5 block text-[11px] text-tva-sand">{hint}</span>}
      {error && <span className="mt-0.5 block text-[11px] text-tva-red" role="alert">{error}</span>}
    </label>
  )
}

export function Tag({ kind = 'mute', children }: { kind?: 'ok' | 'warn' | 'bad' | 'mute'; children: ReactNode }) {
  return <span className={`tag tag-${kind}`}>{children}</span>
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n()
  return <div className="p-6 text-center text-sm text-tva-amber"><span className="animate-blink">&#9608;</span> {label ?? t('common.loading')}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="border-2 border-dashed border-tva-brown p-6 text-center text-sm text-tva-sand">{children}</div>
}

export function Modal({ title, onClose, children, wide = false }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const id = useId()
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', k)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', k)
      document.body.style.overflow = ''
    }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto bg-black/80 p-2 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={id} className={`panel mt-4 w-full ${wide ? 'max-w-6xl' : 'max-w-xl'} bg-tva-dark shadow-tva-glow`}>
        <header className="panel-hd">
          <span id={id}>{title}</span>
          <button className="text-tva-sand hover:text-tva-orange" onClick={onClose} aria-label="close">[ X ]</button>
        </header>
        <div className="panel-bd">{children}</div>
      </div>
    </div>
  )
}

export function Stat({ label, value, sub, kind }: { label: ReactNode; value: ReactNode; sub?: ReactNode; kind?: 'warn' | 'bad' | 'ok' }) {
  const c = kind === 'bad' ? 'text-tva-red' : kind === 'warn' ? 'text-tva-amber' : 'text-tva-orange'
  return (
    <div className="border-2 border-tva-brown bg-tva-panel2 p-3">
      <div className="text-[10px] font-bold uppercase tracking-widest text-tva-sand">{label}</div>
      <div className={`glow-text mt-1 text-2xl font-bold tabular-nums ${c}`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-tva-sand">{sub}</div>}
    </div>
  )
}

export function ConfirmDialog({ title, body, confirmLabel, danger, busy, onConfirm, onCancel, children }: { title: ReactNode; body?: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void; children?: ReactNode }) {
  const { t } = useI18n()
  return (
    <Modal title={title} onClose={onCancel}>
      {body && <p className="mb-3 text-sm">{body}</p>}
      {children}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-solid'}`} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
      </div>
    </Modal>
  )
}
