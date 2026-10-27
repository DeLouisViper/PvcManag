/** CSV (UTF-8 with BOM so Excel shows Vietnamese correctly) and PDF export helpers. Fully client side, free libraries. */

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = "'" + s // neutralise spreadsheet formula injection
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  return rows.map((r) => r.map(esc).join(',')).join('\r\n')
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  download(new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' }), filename)
}

export interface PdfSection {
  title: string
  head: string[]
  body: (string | number)[][]
}

let fontCache: Promise<{ regular: string; bold: string }> | null = null
async function loadFonts() {
  const toB64 = async (url: string) => {
    const buf = await (await fetch(url)).arrayBuffer()
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  }
  const base = import.meta.env.BASE_URL
  fontCache ??= Promise.all([toB64(`${base}fonts/DejaVuSansMono.ttf`), toB64(`${base}fonts/DejaVuSansMono-Bold.ttf`)]).then(([regular, bold]) => ({ regular, bold }))
  return fontCache
}

export async function downloadPdf(filename: string, title: string, meta: string[], sections: PdfSection[]) {
  const [{ default: JsPDF }, { default: autoTable }, fonts] = await Promise.all([import('jspdf'), import('jspdf-autotable'), loadFonts()])
  const doc = new JsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' })
  // DejaVu Sans Mono embeds full Vietnamese glyph coverage (the default PDF fonts do not)
  doc.addFileToVFS('DejaVuSansMono.ttf', fonts.regular)
  doc.addFont('DejaVuSansMono.ttf', 'DejaVu', 'normal')
  doc.addFileToVFS('DejaVuSansMono-Bold.ttf', fonts.bold)
  doc.addFont('DejaVuSansMono-Bold.ttf', 'DejaVu', 'bold')
  doc.setFont('DejaVu', 'bold')
  doc.setFontSize(15)
  doc.text(title, 36, 40)
  doc.setFont('DejaVu', 'normal')
  doc.setFontSize(8.5)
  let y = 56
  for (const line of meta) {
    doc.text(line, 36, y)
    y += 12
  }
  y += 6
  for (const s of sections) {
    doc.setFont('DejaVu', 'bold')
    doc.setFontSize(10)
    const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
    if (last && y < last.finalY + 22) y = last.finalY + 22
    if (y > 520) {
      doc.addPage()
      y = 40
    }
    doc.text(s.title, 36, y)
    autoTable(doc, {
      startY: y + 6,
      head: [s.head],
      body: s.body.map((r) => r.map(String)),
      styles: { font: 'DejaVu', fontSize: 7.5, cellPadding: 3, textColor: 30 },
      headStyles: { font: 'DejaVu', fontStyle: 'bold', fillColor: [74, 44, 20], textColor: 255 },
      alternateRowStyles: { fillColor: [247, 240, 228] },
      margin: { left: 36, right: 36 },
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22
  }
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFont('DejaVu', 'normal')
    doc.setFontSize(7)
    doc.text(`HAIC PVC TERMINAL  -  ${p}/${pages}`, 36, doc.internal.pageSize.getHeight() - 18)
  }
  doc.save(filename)
}
