/** Tiny dependency-free SVG charts in the terminal style (no chart library = tiny bundle, no licence issue). */
import { useMemo } from 'react'

export interface BarDatum { label: string; value: number; color?: string }
const PALETTE = ['#ff8a1f', '#52c4b0', '#ffb54a', '#b7a07a', '#9aa84a', '#ff5a43']

export function BarChart({ data, unit = '', height = 190 }: { data: BarDatum[]; unit?: string; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  const w = 100 / Math.max(1, data.length)
  return (
    <svg viewBox={`0 0 400 ${height}`} className="w-full" role="img" aria-label={data.map((d) => `${d.label}: ${d.value}${unit}`).join(', ')}>
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <line key={g} x1="0" x2="400" y1={height - 28 - (height - 56) * g} y2={height - 28 - (height - 56) * g} stroke="#4a2c14" strokeDasharray="2 4" />
      ))}
      {data.map((d, i) => {
        const bw = Math.min(46, (400 * w) / 100 - 14)
        const x = (400 * w * i) / 100 + ((400 * w) / 100 - bw) / 2
        const h = ((height - 56) * d.value) / max
        return (
          <g key={d.label + i}>
            <rect x={x} y={height - 28 - h} width={bw} height={Math.max(h, d.value > 0 ? 2 : 0)} fill={d.color ?? PALETTE[i % PALETTE.length]} />
            <text x={x + bw / 2} y={height - 32 - h} textAnchor="middle" fontSize="10" fill="#efe1c3">{Number(d.value.toFixed(2))}</text>
            <text x={x + bw / 2} y={height - 12} textAnchor="middle" fontSize="9" fill="#b7a07a">{d.label}</text>
          </g>
        )
      })}
      <line x1="0" x2="400" y1={height - 28} y2={height - 28} stroke="#7a4a24" strokeWidth="2" />
    </svg>
  )
}

export interface Series { name: string; color: string; values: number[] }

export function LineChart({ labels, series, height = 190 }: { labels: string[]; series: Series[]; height?: number }) {
  const max = useMemo(() => Math.max(1, ...series.flatMap((s) => s.values)), [series])
  const n = Math.max(1, labels.length - 1)
  const px = (i: number) => 24 + (352 * i) / n
  const py = (v: number) => height - 28 - ((height - 56) * v) / max
  return (
    <div>
      <svg viewBox={`0 0 400 ${height}`} className="w-full" role="img" aria-label="consumption chart">
        {[0.25, 0.5, 0.75, 1].map((g) => (
          <line key={g} x1="24" x2="376" y1={height - 28 - (height - 56) * g} y2={height - 28 - (height - 56) * g} stroke="#4a2c14" strokeDasharray="2 4" />
        ))}
        <text x="2" y="14" fontSize="9" fill="#b7a07a">{Number(max.toFixed(1))}</text>
        {series.map((s) => (
          <g key={s.name}>
            <polyline fill="none" stroke={s.color} strokeWidth="2" points={s.values.map((v, i) => `${px(i)},${py(v)}`).join(' ')} />
            {s.values.map((v, i) => <rect key={i} x={px(i) - 2.5} y={py(v) - 2.5} width="5" height="5" fill={s.color} />)}
          </g>
        ))}
        {labels.map((l, i) => (labels.length <= 8 || i % Math.ceil(labels.length / 8) === 0) && <text key={l + i} x={px(i)} y={height - 12} textAnchor="middle" fontSize="9" fill="#b7a07a">{l}</text>)}
        <line x1="24" x2="376" y1={height - 28} y2={height - 28} stroke="#7a4a24" strokeWidth="2" />
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-[11px]">
        {series.map((s) => <span key={s.name} className="flex items-center gap-1"><span className="inline-block h-2 w-3" style={{ background: s.color }} />{s.name}</span>)}
      </div>
    </div>
  )
}
