export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

export function btn(label: string, className?: string): HTMLButtonElement {
  const b = el('button', className ?? 'btn')
  b.type = 'button'
  b.textContent = label
  b.dataset.ngBtn = '1'
  return b
}

export function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function hr(): HTMLDivElement {
  const d = el('div')
  d.style.height = '1px'
  d.style.background = 'rgba(0,229,255,0.08)'
  d.style.margin = '10px 0'
  return d
}

export function kv(k: string, v: string, mono = false): HTMLDivElement {
  const box = el('div', 'kv')
  const kk = el('div', 'k')
  kk.textContent = k
  const vv = el('div', 'v' + (mono ? ' mono' : ''))
  vv.textContent = v
  box.append(kk, vv)
  return box
}
