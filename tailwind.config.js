/** @type {import('tailwindcss').Config} */
// TVA Loki inspired palette: 1970s administrative terminal, burnt orange on deep brown-black.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'tva-dark': '#14100c',
        'tva-panel': '#1d1711',
        'tva-panel2': '#271e15',
        'tva-brown': '#7a4a24',
        'tva-brown-dark': '#4a2c14',
        'tva-orange': '#ff8a1f',
        'tva-amber': '#ffb54a',
        'tva-cream': '#efe1c3',
        'tva-sand': '#b7a07a',
        'tva-teal': '#52c4b0',
        'tva-red': '#ff5a43',
        'tva-olive': '#9aa84a',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'tva-glow': '0 0 14px rgba(255,138,31,0.45), 0 0 2px rgba(255,138,31,0.9)',
        'tva-glow-teal': '0 0 12px rgba(82,196,176,0.4), 0 0 2px rgba(82,196,176,0.9)',
        'tva-glow-red': '0 0 12px rgba(255,90,67,0.45), 0 0 2px rgba(255,90,67,0.9)',
        'tva-hard': '4px 4px 0 0 #4a2c14',
      },
      keyframes: {
        blink: { '0%,49%': { opacity: '1' }, '50%,100%': { opacity: '0.15' } },
        flicker: { '0%': { opacity: '0.97' }, '50%': { opacity: '1' }, '100%': { opacity: '0.985' } },
        boot: { '0%': { opacity: '0', transform: 'translateY(4px)' }, '100%': { opacity: '1', transform: 'none' } },
      },
      animation: {
        blink: 'blink 1.2s steps(1) infinite',
        flicker: 'flicker 0.18s infinite alternate',
        boot: 'boot 0.25s ease-out both',
      },
    },
  },
  plugins: [],
}
