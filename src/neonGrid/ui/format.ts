import type { NumberFormat } from '../types'

const SHORT_SUFFIXES = ['', 'K', 'M', 'B', 'T']

function alphaSuffix(index: number): string {
  // 0 -> aa, 1 -> ab, ... 25 -> az, 26 -> ba, ...
  const a = 'a'.charCodeAt(0)
  const first = Math.floor(index / 26)
  const second = index % 26
  return String.fromCharCode(a + first) + String.fromCharCode(a + second)
}

export function formatNumber(v: number, mode: NumberFormat): string {
  if (!Number.isFinite(v)) return '∞'
  if (v === 0) return '0'

  const sign = v < 0 ? '-' : ''
  let x = Math.abs(v)

  if (mode === 'scientific') {
    const exp = Math.floor(Math.log10(x))
    const mant = x / Math.pow(10, exp)
    return `${sign}${mant.toFixed(3)}e${exp}`
  }

  if (x < 1000) return `${sign}${x.toFixed(x < 10 ? 2 : x < 100 ? 1 : 0)}`

  const exp3 = Math.floor(Math.log10(x) / 3)
  const scaled = x / Math.pow(10, exp3 * 3)

  if (exp3 < SHORT_SUFFIXES.length) {
    const suf = SHORT_SUFFIXES[exp3]
    return `${sign}${scaled.toFixed(scaled < 10 ? 2 : 1)}${suf}`
  }

  const alphaIndex = exp3 - SHORT_SUFFIXES.length
  const suf = alphaSuffix(alphaIndex)
  return `${sign}${scaled.toFixed(scaled < 10 ? 2 : 1)}${suf}`
}

export function formatPaladyum(v: number): string {
  if (!Number.isFinite(v)) return '∞'
  const sign = v < 0 ? '-' : ''
  const x = Math.abs(v)
  // Always show up to 7 decimal places for Paladyum (e.g. 0.0000123)
  return `${sign}${x.toFixed(7)}`
}

export function formatPaladyumInt(v: number): string {
  if (!Number.isFinite(v)) return '∞'
  if (v === 0) return '0'
  // Truncate toward zero (deterministic + avoids showing more than owned).
  const n = v < 0 ? Math.ceil(v - 1e-9) : Math.floor(v + 1e-9)
  return String(n)
}

export function formatPaladyumInt2(v: number): string {
  const s = formatPaladyumInt(v)
  if (s === '∞') return s
  if (s.startsWith('-')) return '-' + s.slice(1).padStart(2, '0')
  return s.padStart(2, '0')
}

export function formatTimeMMSS(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

export function formatPct(v01: number): string {
  const v = Math.max(0, Math.min(1, v01))
  return `${(v * 100).toFixed(0)}%`
}
