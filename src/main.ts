import './style.css'
import { createNeonGridApp } from './neonGrid/app'

const gameRoot = document.querySelector<HTMLDivElement>('#game')
const uiRoot = document.querySelector<HTMLDivElement>('#ui')

if (!gameRoot || !uiRoot) {
  throw new Error('Missing #game or #ui root elements')
}

void createNeonGridApp({ gameRoot, uiRoot })

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // ignore
    })
  })
}
