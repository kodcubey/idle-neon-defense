import type { GameConfig, GameState, OfflineProgressResult, RunSummary, TowerUpgradeKey, WaveReport } from '../types'
import type { NeonGridGame } from '../phaser/createGame'
import type { SimPublic } from '../sim/SimEngine'
import { applyCloudMetaToState, type FirebaseSync } from '../persistence/firebaseSync'
import { createNewState, saveSnapshot } from '../persistence/save'
import { btn, clear, el, hr, kv } from './dom'
import { formatNumber, formatPaladyumInt, formatPct, formatTimeMMSS } from './format'
import {
  aggregateModules,
  baseDmg,
  calcDPS,
  calcPenaltyFactor,
  calcWaveSnapshot,
  clamp,
  critAverageDamageMult,
  effectiveCritParams,
  effectiveEnemySpeedMult,
  fireRate,
  towerArmorPierceBonus,
  towerEscapeDamageMult,
  towerGoldMult,
  towerMultiShotCount,
  towerRange,
  towerRepairPctPerSec,
  towerEnemySpeedMult,
} from '../sim/deterministic'
import { calcBaseHPMax } from '../sim/actions'
import { metaUpgradeCostPoints, moduleSlotUnlockCostPoints, moduleUnlockCostPoints, moduleUpgradeCostPoints, upgradeCost, upgradeMaxLevel } from '../sim/costs'
import { claimDailyContract, getDailyContracts, type DailyContractView } from '../sim/contracts'

export type UIScreen = 'boot' | 'menu' | 'login' | 'hud' | 'modules' | 'settings' | 'stats' | 'offline'

type UIArgs = {
  root: HTMLElement
  config: GameConfig
  initialState: UIScreen
  offlineResult: OfflineProgressResult
  firebaseSync?: FirebaseSync
}

export function createUIStateMachine(args: UIArgs) {
  const { root, config } = args
  const firebaseSync: FirebaseSync | null = args.firebaseSync ?? null

  let registerUsername = ''
  let registerEmail = ''
  let registerPassword = ''
  let registerRePassword = ''
  let loginIdentifier = ''
  let loginPassword = ''

  let authUsername: string | null = null
  let initialCloudSyncDone = false
  let initialCloudSyncInProgress = false
  let resetRequested = false

  let refreshContractsBadgeGlobal: (() => void) | null = null

  let upgradesTab: 'attack' | 'defense' | 'utility' = 'attack'

  // In dev/HMR or accidental re-init, multiple UI layers can stack and swallow clicks.
  // Reset the UI root so only one active layer exists.
  clear(root)

  // Some runtimes end up not dispatching native 'click' for pointer interactions.
  // Bridge pointer interactions -> onclick for our UI buttons, and suppress the follow-up
  // native click to avoid double-firing when native click *does* occur.
  // IMPORTANT: Do not fire on pointerdown; it breaks scrolling on touch devices.
  if (!(root as any).__ngBtnBridgeInstalled) {
    ;(root as any).__ngBtnBridgeInstalled = true
    const lastSyntheticAt = new WeakMap<HTMLButtonElement, number>()
    const activePointer = new Map<number, { button: HTMLButtonElement; x: number; y: number; moved: boolean }>()
    const MOVE_PX = 8

    root.addEventListener(
      'pointerdown',
      (e) => {
        const pe = e as PointerEvent
        if (!pe.isPrimary) return
        if (typeof pe.button === 'number' && pe.button !== 0) return

        const target = pe.target as Element | null
        const button = target?.closest?.('button[data-ng-btn="1"]') as HTMLButtonElement | null
        if (!button || button.disabled) return

        // Track pointer so we can synthesize a click on pointerup
        // only if the gesture didn't turn into a scroll.
        activePointer.set(pe.pointerId, { button, x: pe.clientX, y: pe.clientY, moved: false })
      },
      true,
    )

    root.addEventListener(
      'pointermove',
      (e) => {
        const pe = e as PointerEvent
        const rec = activePointer.get(pe.pointerId)
        if (!rec) return
        const dx = pe.clientX - rec.x
        const dy = pe.clientY - rec.y
        if (Math.hypot(dx, dy) >= MOVE_PX) rec.moved = true
      },
      true,
    )

    const endPointer = (pe: PointerEvent, cancelled: boolean) => {
      const rec = activePointer.get(pe.pointerId)
      if (!rec) return
      activePointer.delete(pe.pointerId)
      if (cancelled) return
      if (rec.moved) return

      // Prevent focus/selection quirks and help avoid an additional native click.
      pe.preventDefault()

      lastSyntheticAt.set(rec.button, performance.now())
      const handler = rec.button.onclick
      if (handler) {
        handler.call(rec.button, new MouseEvent('click', { bubbles: true, cancelable: true, view: window }) as any)
      }
    }

    root.addEventListener(
      'pointerup',
      (e) => endPointer(e as PointerEvent, false),
      true,
    )

    root.addEventListener(
      'pointercancel',
      (e) => endPointer(e as PointerEvent, true),
      true,
    )

    root.addEventListener(
      'click',
      (e) => {
        const target = e.target as Element | null
        const button = target?.closest?.('button[data-ng-btn="1"]') as HTMLButtonElement | null
        if (!button) return

        const t = lastSyntheticAt.get(button)
        if (!t) return
        if (performance.now() - t > 800) return

        // Swallow the native click; we've already invoked onclick on pointerdown.
        e.preventDefault()
        e.stopImmediatePropagation()
        lastSyntheticAt.delete(button)
      },
      true,
    )
  }

  // Optional dev helper: add ?debugClicks=1 to the URL.
  const debugClicks = (() => {
    try {
      return typeof location !== 'undefined' && new URLSearchParams(location.search).get('debugClicks') === '1'
    } catch {
      return false
    }
  })()

  if (import.meta.env.DEV && debugClicks && !(window as any).__ng_debugClicksInstalled) {
    ;(window as any).__ng_debugClicksInstalled = true
    window.addEventListener(
      'pointerdown',
      (e) => {
        const topEl = document.elementFromPoint(e.clientX, e.clientY)
        // eslint-disable-next-line no-console
        console.log('[debugClicks] target=', e.target, 'elementFromPoint=', topEl)
      },
      true,
    )
  }

  const layer = el('div', 'ui-layer')
  root.appendChild(layer)

  let game: NeonGridGame | null = null
  let lastState: GameState | null = null
  let lastSim: SimPublic | null = null

  let modulesFilter: 'ALL' | 'OFFENSE' | 'DEFENSE' | 'UTILITY' = 'ALL'
  let modulesPage = 0
  const MODULES_PER_PAGE = 9

  // Prevent accidental click-to-unequip triggered right after a successful drop.
  let lastSlotDropAtMs = 0

  let screen: UIScreen = args.initialState

  const top = el('div', 'hud-top')
  const center = el('div', 'ui-center')
  const bottom = el('div')

  layer.append(top, center, bottom)

  // Keep Settings status in sync with auth state.
  // IMPORTANT: this must run after `top/center/bottom` are initialized,
  // otherwise `render()` would touch `top` in its temporal-dead-zone.
  if (firebaseSync && !(root as any).__ngFirebaseAuthListenerInstalled) {
    ;(root as any).__ngFirebaseAuthListenerInstalled = true
    firebaseSync.onAuthChanged(() => {
      const st = firebaseSync.getStatus()
      if (!st.signedIn) {
        authUsername = null
        initialCloudSyncDone = false
        initialCloudSyncInProgress = false

        // On sign-out, fully reset local meta/progression so the next
        // sign-in starts from the correct user's cloud data.
        if (game) {
          setFreshLocalSnapshot(true)
        } else {
          resetRequested = true
        }
      }
      render()
      void maybeInitialCloudSync()
    })
  }

  function setFreshLocalSnapshot(forceMenuPause: boolean) {
    if (!game) return
    const fresh = createNewState(config, Date.now())
    game.setSnapshot(fresh, 'hard')
    lastState = game.getSnapshot()
    if (forceMenuPause) {
      game.setPaused(true)
      screen = 'menu'
    }
  }

  function mountModal(panel: HTMLElement): HTMLDivElement {
    // Create a per-modal full-screen overlay so it can't get "stuck" globally.
    const overlay = el('div')
    overlay.className = 'ng-modal-overlay'
    overlay.style.position = 'absolute'
    overlay.style.inset = '0'
    overlay.style.pointerEvents = 'auto'
    overlay.style.zIndex = '10000'
    root.appendChild(overlay)
    overlay.appendChild(panel)
    return overlay
  }

  async function withLoading<T>(task: () => Promise<T>): Promise<T> {
    const modal = el('div', 'panel')
    modal.style.width = 'min(420px, calc(100vw - 24px))'
    modal.style.pointerEvents = 'auto'

    const h = el('div', 'panel-header')
    h.textContent = 'Loading'
    const b = el('div', 'panel-body')

    const row = el('div')
    row.style.display = 'flex'
    row.style.gap = '10px'
    row.style.alignItems = 'center'

    const spin = el('div')
    spin.className = 'ng-spinner'

    const txt = el('div', 'muted')
    txt.textContent = 'Please wait…'

    row.append(spin, txt)
    b.appendChild(row)
    modal.append(h, b)

    const overlay = mountModal(modal)
    try {
      return await task()
    } finally {
      overlay.remove()
    }
  }

  async function maybeInitialCloudSync(): Promise<void> {
    if (!firebaseSync) return
    const st = firebaseSync.getStatus()
    if (!st.configured || !st.signedIn) return
    if (initialCloudSyncDone || initialCloudSyncInProgress) return
    if (!game) return

    initialCloudSyncInProgress = true
    try {
      await withLoading(async () => {
        // Always start from a clean local state for the signed-in user
        // to avoid mixing previous user's meta into this session.
        setFreshLocalSnapshot(true)

        // First login in this session:
        // - If no cloud doc exists: create it from local snapshot.
        // - If it exists: pull from cloud and apply locally.
        const cloudMeta = await firebaseSync.downloadMeta()
        if (!cloudMeta) {
          await firebaseSync.uploadMetaFromState(game!.getSnapshot())
        } else {
          const cur = game!.getSnapshot()
          game!.setSnapshot(applyCloudMetaToState(cur, cloudMeta))
          lastState = game!.getSnapshot()
        }

        // Never auto-start gameplay due to auth/sync.
        game!.setPaused(true)
        screen = 'menu'

        try {
          authUsername = await firebaseSync.getUsername()
        } catch {
          authUsername = null
        }
      })

      initialCloudSyncDone = true
      render()
    } finally {
      initialCloudSyncInProgress = false
    }
  }

  function cleanupStaleModalOverlays() {
    const overlays = root.querySelectorAll<HTMLDivElement>('.ng-modal-overlay')
    overlays.forEach((o) => {
      // If an overlay ends up empty (e.g., an exception during modal construction),
      // it will swallow all clicks. Remove it defensively.
      if (!o.firstElementChild) o.remove()
    })
  }

  function flashFail(button: HTMLButtonElement) {
    button.classList.add('btn-danger')
    window.setTimeout(() => button.classList.remove('btn-danger'), 260)
  }

  function getSimOrFallback(state: GameState): SimPublic {
    if (lastSim) return lastSim

    const snap = calcWaveSnapshot(state, config)
    return {
      state,
      wave: snap,
      waveTimeSec: 0,
      killed: 0,
      escaped: 0,
      spawnedSoFar: 0,
      timeScale: 2,
      paused: true,
      enemies: [],
      projectiles: [],
      arena: {
        center: { x: 0, y: 0 },
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
        maxSpawnDist: 1,
        baseHalfSize: 1,
      },
      tower: {
        pos: { x: 0, y: 0 },
        range: 0,
        armorPierce: 0,
        damagePerShot: 0,
        fireRate: 0,
      },
    }
  }

  function computeTowerUIStats(state: GameState) {
    const mods = aggregateModules(state, config)

    const baseDamage = baseDmg(state.towerUpgrades.damageLevel, config)
    const damagePerShot = Math.max(0, baseDamage * mods.dmgMult + mods.dmgFlat)
    const crit = effectiveCritParams(state, config, mods)
    const critAvg = critAverageDamageMult(state, config, mods)

    const fireRateBase = fireRate(state.towerUpgrades.fireRateLevel, config)
    const fireRateFinal = Math.max(0.1, fireRateBase * (1 + mods.fireRateBonus))

    const rangeBase = towerRange(state.towerUpgrades.rangeLevel, config)
    const rangeFinal = Math.max(0, rangeBase + mods.rangeBonus)

    const armorPierceBonus = towerArmorPierceBonus(state, config)
    const armorPierceFinal = clamp(mods.armorPierce + armorPierceBonus, 0, 0.9)

    const baseTargets = towerMultiShotCount(state, config)
    const targetsFinal = Math.max(1, Math.floor(Math.max(baseTargets, mods.shotCount)))

    const maxHP = Math.max(1, calcBaseHPMax(state, config))
    const repairPct = towerRepairPctPerSec(state, config)

    const slowBaseMult = towerEnemySpeedMult(state, config)
    const slowFinalMult = effectiveEnemySpeedMult(state, config, mods)

    const escapeDamageMult = towerEscapeDamageMult(state, config)

    const goldMultFinal = Math.max(0, mods.goldMult * towerGoldMult(state, config))

    const dps = calcDPS(state, config)

    return {
      mods,
      dps,

      baseDamage,
      damagePerShot,
      crit,
      critAvg,

      fireRateBase,
      fireRateFinal,

      rangeBase,
      rangeFinal,

      armorPierceBonus,
      armorPierceFinal,

      baseTargets,
      targetsFinal,

      maxHP,
      repairPct,

      slowBaseMult,
      slowFinalMult,

      escapeDamageMult,
      goldMultFinal,

      invulnDurationSec: mods.invulnDurationSec,
      invulnCooldownSec: mods.invulnCooldownSec,
    }
  }

  function setScreen(next: UIScreen) {
    screen = next
    if (game && (next === 'menu' || next === 'login' || next === 'boot' || next === 'offline')) {
      game.setPaused(true)
    }
    if (game && next === 'hud') {
      // Ensure HUD reflects the latest snapshot immediately (module equips, cloud meta, etc.)
      lastState = game.getSnapshot()
    }
    render()
  }

  function render() {
    cleanupStaleModalOverlays()

    // Hard guarantee: home-related screens never run gameplay.
    if (game && (screen === 'menu' || screen === 'login' || screen === 'boot' || screen === 'offline')) {
      game.setPaused(true)
    }

    clear(top)
    clear(center)
    clear(bottom)

    if (screen === 'boot') {
      renderBoot()
      return
    }

    if (screen === 'offline') {
      renderMenu()
      renderHUD(true)
      return
    }

    if (screen === 'menu') {
      renderMenu()
      return
    }

    if (screen === 'login') {
      renderLogin()
      return
    }

    // In-game / overlays
    renderHUD(screen !== 'hud')

    if (screen === 'modules') renderModules()
    if (screen === 'settings') renderSettings()
    if (screen === 'stats') renderStats()
  }

  function renderBoot() {
    const panel = el('div', 'panel')
    panel.style.maxWidth = '520px'
    panel.style.margin = 'auto'
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    const title = el('div')
    title.textContent = 'NEON GRID'
    header.appendChild(title)

    const badge = el('div', 'muted')
    badge.textContent = 'No RNG / Deterministic'
    header.appendChild(badge)

    const body = el('div', 'panel-body')
    const p = el('div')
    p.textContent = 'Starting deterministic simulation…'
    p.style.marginBottom = '10px'

    const bar = el('div', 'bar')
    const fill = el('div', 'fill')
    fill.style.width = '0%'
    bar.appendChild(fill)

    const tip = el('div', 'muted')
    tip.style.marginTop = '10px'

    const tips = config.ui.tipsTR
    const dayIndex = Math.floor(Date.now() / 86400_000)
    tip.textContent = `Tip: ${tips[dayIndex % tips.length]}`

    body.append(p, bar, tip)
    panel.append(header, body)
    center.appendChild(panel)

    // Deterministic-ish animation not used for gameplay; purely visual.
    let t = 0
    const id = window.setInterval(() => {
      t += 0.08
      fill.style.width = `${Math.min(100, t * 100)}%`
      if (t >= 1) {
        window.clearInterval(id)
        setScreen('menu')
      }
    }, 60)
  }

  function renderMenu() {
    const layout = el('div', 'ng-menu-layout')

    const panel = el('div', 'panel ng-menu')

    const header = el('div', 'panel-header')
    const title = el('div', 'ng-menu-title')
    title.textContent = 'NEON GRID'
    header.appendChild(title)

    const ver = el('div', 'muted mono')
    ver.textContent = `v${config.version}`
    header.appendChild(ver)

    const body = el('div', 'panel-body')

    const authLine = (() => {
      const st = firebaseSync?.getStatus()
      const line = el('div', 'muted')
      if (!firebaseSync) return null
      if (!st?.configured) {
        line.textContent = 'Firebase not configured.'
        return line
      }
      if (!st.signedIn) {
        line.textContent = 'Not signed in.'
        return line
      }

      const uname = authUsername?.trim()
      line.textContent = `Signed in as: ${uname ? uname : st.email ?? 'user'}`
      return line
    })()

    const desc = el('div', 'muted')
    desc.textContent = 'No RNG: All outcomes are deterministic. Wave duration is fixed.'

    const balances = (() => {
      const st = firebaseSync?.getStatus()
      if (!firebaseSync || !st?.configured || !st.signedIn) return null

      const balances = el('div', 'muted')
      balances.style.marginTop = '10px'
      const pal = lastState?.points ?? 0
      balances.innerHTML = `Paladyum: <span class="mono">${formatPaladyumInt(pal)}</span>`
      return balances
    })()

    const row = el('div', 'ng-menu-actions')
    row.style.marginTop = '12px'

    const menuBtn = (label: string, iconSVG: string, iconTone: 'cyan' | 'magenta' | 'lime', extraClass?: string) => {
      const b = btn('', 'btn' + (extraClass ? ` ${extraClass}` : ''))
      b.textContent = ''

      const ic = el('span', `ng-btn-icon ng-icon-${iconTone}`)
      ic.innerHTML = iconSVG

      const tx = el('span', 'ng-btn-label')
      tx.textContent = label

      b.append(ic, tx)
      return b
    }

    const iconPlay = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 7.2v9.6c0 .7.8 1.1 1.4.7l8-4.8c.6-.4.6-1.2 0-1.6l-8-4.8c-.6-.4-1.4 0-1.4.9Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      </svg>
    `

    const iconHex = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 3.8 16 3.8 20.2 10.9 16 20.2 8 20.2 3.8 10.9 8 3.8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M8.8 10.6 11.3 8.1 15.9 12.7 13.4 15.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `

    const iconGrid = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      </svg>
    `

    const iconTower = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 3 6.5 7v5.4c0 4.3 2.7 7.9 5.5 8.6 2.8-.7 5.5-4.3 5.5-8.6V7L12 3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M9 10h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M10 14h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `

    const iconChart = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 19V5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M8 16v-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M12 16v-8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M16 16v-3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `

    const iconGear = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" stroke="currentColor" stroke-width="2"/>
        <path d="M19.5 13.2v-2.4l-2.1-.6a7.9 7.9 0 0 0-.7-1.2l1-1.9-1.7-1.7-1.9 1a7.9 7.9 0 0 0-1.2-.7L13.2 4.5h-2.4l-.6 2.1a7.9 7.9 0 0 0-1.2.7l-1.9-1L5.4 8.1l1 1.9a7.9 7.9 0 0 0-.7 1.2l-2.1.6v2.4l2.1.6c.2.4.4.8.7 1.2l-1 1.9 1.7 1.7 1.9-1c.4.3.8.5 1.2.7l.6 2.1h2.4l.6-2.1c.4-.2.8-.4 1.2-.7l1.9 1 1.7-1.7-1-1.9c.3-.4.5-.8.7-1.2l2.1-.6Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      </svg>
    `

    const iconInfo = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" stroke="currentColor" stroke-width="2"/>
        <path d="M12 10.5V17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M12 7.5h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
      </svg>
    `

    const iconClipboard = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 3h6v3H9V3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M7 6h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M8 11h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M8 15h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `

    const requireLogin = (): boolean => {
      if (!firebaseSync) {
        alert('Login is unavailable.')
        return false
      }
      const st = firebaseSync.getStatus()
      if (!st.configured) {
        alert('Login is unavailable.')
        return false
      }
      if (!st.signedIn) {
        alert("You must log in. If you don't have an account, please sign up.")
        setScreen('login')
        return false
      }
      return true
    }

    const newRun = menuBtn('New Run', iconPlay, 'lime')
    newRun.onclick = () => {
      void (async () => {
        if (!game) return

        const st = firebaseSync?.getStatus()
        const canCloud = !!firebaseSync && !!st?.configured && !!st?.signedIn
        if (canCloud) {
          try {
            await withLoading(async () => {
              game!.setPaused(true)
              await maybeInitialCloudSync()

              const cloudMeta = await firebaseSync!.downloadMeta()
              if (!cloudMeta) {
                await firebaseSync!.uploadMetaFromState(game!.getSnapshot())
              } else {
                const cur = game!.getSnapshot()
                game!.setSnapshot(applyCloudMetaToState(cur, cloudMeta))
                lastState = game!.getSnapshot()
              }
            })
          } catch (e) {
            alert(String((e as any)?.message ?? e))
          }
        }

        game.newRun()
        setScreen('hud')
      })()
    }

    const modules = menuBtn('Modules', iconGrid, 'cyan')
    modules.onclick = () => {
      void (async () => {
        if (!requireLogin()) return
        if (game) game.setPaused(true)
        await showModulesModal()
      })()
    }

    const stats = menuBtn('Stats', iconChart, 'cyan')
    stats.onclick = () => {
      if (!requireLogin()) return
      if (game) game.setPaused(true)
      showStatsModal()
    }

    const settings = menuBtn('Settings', iconGear, 'magenta')
    settings.onclick = () => {
      if (game) game.setPaused(true)
      showSettingsModal()
    }

    const how = menuBtn('How to Play', iconInfo, 'cyan')
    how.onclick = () => {
      if (game) game.setPaused(true)
      showHowToPlayModal()
    }

    const tower = menuBtn('Tower', iconTower, 'magenta')
    tower.onclick = () => {
      if (!requireLogin()) return
      if (game) game.setPaused(true)
      showTowerModal()
    }

    const metaUpg = menuBtn('Meta Upgrades', iconHex, 'lime')
    metaUpg.onclick = () => {
      if (!lastState) return
      if (!requireLogin()) return
      void showMetaUpgradesModal()
    }

    const contracts = menuBtn('Contracts', iconClipboard, 'cyan')
    const contractsBadge = el('span', 'ng-menu-badge')
    contractsBadge.style.display = 'none'
    contracts.appendChild(contractsBadge)

    const refreshContractsBadge = () => {
      const snapshot = game ? game.getSnapshot() : lastState
      if (!snapshot) {
        contractsBadge.style.display = 'none'
        contractsBadge.textContent = ''
        return
      }

      const nowUTC = Date.now()
      const info = getDailyContracts({ state: snapshot, config, nowUTC })
      if (info.state !== snapshot) {
        lastState = info.state
        if (game) game.setSnapshot(info.state, 'soft')
      }

      const claimable = info.contracts.filter((c) => c.completed && !c.claimed).length
      if (claimable > 0) {
        contractsBadge.textContent = String(claimable)
        contractsBadge.style.display = ''
      } else {
        contractsBadge.style.display = 'none'
        contractsBadge.textContent = ''
      }
    }

    refreshContractsBadgeGlobal = refreshContractsBadge

    refreshContractsBadge()
    contracts.onclick = () => {
      if (game) game.setPaused(true)
      void (async () => {
        await showDailyContractsModal()
        refreshContractsBadge()
      })()
    }

    row.append(newRun, metaUpg, contracts, modules, tower, stats, settings, how)

    const about = el('div', 'panel')
    about.style.marginTop = '12px'
    const ch = el('div', 'panel-header')
    ch.textContent = 'No RNG Mode'
    const cb = el('div', 'panel-body')
    cb.innerHTML = `
      <div class="muted">• Deterministic formulas: no drops, no luck.</div>
      <div class="muted">• Miss KR target: reward multiplier drops, escapes can damage Base.</div>
      <div class="muted">• Each wave lasts exactly ${config.sim.waveDurationSec.toFixed(1)}s.</div>
    `
    about.append(ch, cb)

    const authPanel = (() => {
      const st = firebaseSync?.getStatus()
      if (!firebaseSync || !st?.configured) return null
      if (st.signedIn) return null

      const authPanel = el('div', 'panel')
      authPanel.style.marginTop = '12px'
      const ah = el('div', 'panel-header')
      ah.textContent = 'Register'
      const ab = el('div', 'panel-body')

      const uname = document.createElement('input')
      uname.type = 'text'
      uname.placeholder = 'Username…'
      uname.value = registerUsername
      uname.oninput = () => {
        registerUsername = uname.value
      }

      const email = document.createElement('input')
      email.type = 'email'
      email.placeholder = 'Email…'
      email.value = registerEmail
      email.oninput = () => {
        registerEmail = email.value
      }

      const pass = document.createElement('input')
      pass.type = 'password'
      pass.placeholder = 'Password…'
      pass.value = registerPassword
      pass.oninput = () => {
        registerPassword = pass.value
      }

      const repass = document.createElement('input')
      repass.type = 'password'
      repass.placeholder = 'Re-enter password…'
      repass.value = registerRePassword
      repass.oninput = () => {
        registerRePassword = repass.value
      }

      const formRow1 = el('div', 'stack')
      formRow1.append(uname, email)
      const formRow2 = el('div', 'stack')
      formRow2.style.marginTop = '8px'
      formRow2.append(pass, repass)

      const actions = el('div', 'stack')
      actions.style.marginTop = '10px'
      const registerBtn = btn('Register', 'btn btn-primary')
      registerBtn.onclick = async () => {
        try {
          if (registerPassword !== registerRePassword) {
            alert('Passwords do not match.')
            return
          }
          await withLoading(async () => {
            game?.setPaused(true)
            await firebaseSync?.signUpUsernameEmailPassword(registerUsername, registerEmail, registerPassword)
            await maybeInitialCloudSync()
          })
          alert('Registered.')
          registerPassword = ''
          registerRePassword = ''
          render()
        } catch (e) {
          alert(String((e as any)?.message ?? e))
        }
      }

      const goLogin = btn('Go to Login', 'btn')
      goLogin.onclick = () => setScreen('login')

      actions.append(registerBtn, goLogin)

      ab.append(formRow1, formRow2, actions)
      authPanel.append(ah, ab)
      return authPanel
    })()

    const signedInPanel = (() => {
      const st = firebaseSync?.getStatus()
      if (!firebaseSync || !st?.configured) return null
      if (!st.signedIn) return null

      const p = el('div', 'panel')
      p.style.marginTop = '12px'
      const ph = el('div', 'panel-header')
      ph.textContent = 'Account'
      const pb = el('div', 'panel-body')

      const uname = authUsername?.trim()
      const l = el('div', 'muted')
      l.textContent = `Username: ${uname ? uname : '—'}`

      const actions = el('div', 'stack')
      actions.style.marginTop = '10px'
      const signOut = btn('Sign out', 'btn btn-danger')
      signOut.onclick = async () => {
        try {
          await withLoading(async () => {
            await firebaseSync.signOut()
          })
          setFreshLocalSnapshot(true)
          alert('Signed out.')
          render()
        } catch (e) {
          alert(String((e as any)?.message ?? e))
        }
      }
      actions.append(signOut)

      pb.append(l, actions)
      p.append(ph, pb)
      return p
    })()

    const topInfo = el('div')
    if (authLine) {
      authLine.style.marginTop = '10px'
      topInfo.appendChild(authLine)
    }
    desc.style.marginTop = '6px'
    topInfo.appendChild(desc)
    if (balances) topInfo.appendChild(balances)

    body.append(topInfo, row, about)
    if (authPanel) body.appendChild(authPanel)
    if (signedInPanel) body.appendChild(signedInPanel)

    panel.append(header, body)
    layout.appendChild(panel)
    center.appendChild(layout)
  }

  async function showMetaUpgradesModal() {
    if (!lastState || !game) return

    const g = game

    const refreshMetaFromCloud = async (opts?: { showSpinner?: boolean }) => {
      if (!firebaseSync) return
      const st = firebaseSync.getStatus()
      if (!st.configured || !st.signedIn) return

      const task = async () => {
        const cloudMeta = await firebaseSync.downloadMeta()
        if (!cloudMeta) return
        const cur = g.getSnapshot()
        g.setSnapshot(applyCloudMetaToState(cur, cloudMeta))
        lastState = g.getSnapshot()
      }

      if (opts?.showSpinner) await withLoading(task)
      else await task()
    }

    // On every open, re-fetch Paladyum/meta from the DB.
    await refreshMetaFromCloud({ showSpinner: true })

    const modal = el('div', 'panel ng-meta-modal')
    modal.style.width = 'min(760px, calc(100vw - 20px))'
    modal.style.pointerEvents = 'auto'

    const h = el('div', 'panel-header')
    const title = el('div')
    title.textContent = 'Meta Upgrades (Permanent)'
    const close = btn('Close', 'btn')
    const overlay = mountModal(modal)
    close.onclick = () => {
      overlay.remove()

      // On close, pull again (no spinner) so the menu Paladyum stays in sync.
      void (async () => {
        try {
          await refreshMetaFromCloud()
        } finally {
          render()
        }
      })()
    }
    h.append(title, close)

    const b = el('div', 'panel-body ng-meta-body')

    const bal = el('div', 'muted ng-meta-balance')
    bal.innerHTML = `Paladyum: <span class="mono">${formatPaladyumInt(lastState.points)}</span>`

    const top = el('div', 'ng-meta-top')
    const tabs = renderUpgradesTabs(() => {
      overlay.remove()
      void showMetaUpgradesModal()
    })
    tabs.classList.add('ng-meta-tabs')
    top.append(bal, tabs)
    b.append(top)

    const levelOf = (key: TowerUpgradeKey) => {
      const m = (lastState as any).towerMetaUpgrades
      if (!m) return 1
      switch (key) {
        case 'damage':
          return m.damageLevel
        case 'fireRate':
          return m.fireRateLevel
        case 'crit':
          return m.critLevel
        case 'multiShot':
          return m.multiShotLevel
        case 'armorPierce':
          return m.armorPierceLevel
        case 'range':
          return m.rangeLevel
        case 'baseHP':
          return m.baseHPLevel
        case 'slow':
          return m.slowLevel
        case 'fortify':
          return m.fortifyLevel
        case 'repair':
          return m.repairLevel
        case 'gold':
          return m.goldLevel
      }
    }

    const renderMetaRow = (label: string, key: TowerUpgradeKey) => {
      const level = Math.max(1, Math.floor(levelOf(key)))
      const maxL = upgradeMaxLevel(key, config)
      const atMax = level >= maxL
      const nextCost = atMax ? 'MAX' : formatNumber(metaUpgradeCostPoints(key, level, config), lastState?.settings.numberFormat ?? 'suffix')

      const card = el('div', 'panel ng-meta-row')
      const ch = el('div', 'panel-header ng-meta-row-head')
      const leftHead = el('div', 'ng-meta-row-title')
      leftHead.textContent = label
      const rightHead = el('div', 'muted mono ng-meta-row-level')
      rightHead.textContent = `Lv ${level}${Number.isFinite(maxL) ? ` / ${maxL}` : ''}`
      ch.append(leftHead, rightHead)

      const cb = el('div', 'panel-body ng-meta-row-body')
      const info = el('div', 'ng-meta-row-info')
      const costLabel = el('div', 'muted mono')
      costLabel.textContent = 'Next cost'
      const costVal = el('div', 'mono ng-meta-row-cost')
      costVal.textContent = String(nextCost)
      info.append(costLabel, costVal)

      const controls = el('div', 'ng-meta-controls')
      const b1 = btn('+1', 'btn')
      const b10 = btn('+10', 'btn')
      const bM = btn('+Max', 'btn')

      const points = Math.max(0, Number((lastState as any)?.points ?? 0))
      const canAffordMetaN = (n: number) => {
        if (atMax) return false
        let total = 0
        for (let i = 0; i < n; i++) {
          const L = level + i
          if (L >= maxL) return false
          total += metaUpgradeCostPoints(key, L, config)
          if (!Number.isFinite(total) || points < total) return false
        }
        return true
      }

      if (atMax) {
        b1.disabled = true
        b10.disabled = true
        bM.disabled = true
      } else {
        b1.disabled = !canAffordMetaN(1)
        b10.disabled = !canAffordMetaN(10)
        bM.disabled = !canAffordMetaN(1)
      }

      const doBuy = async (amt: 1 | 10 | 'max', elBtn: HTMLButtonElement) => {
        if (!game) {
          flashFail(elBtn)
          return
        }
        const g = game

        let buyOk = false
        await withLoading(async () => {
          // Refresh from DB before the purchase so costs/points are up to date.
          const st = firebaseSync?.getStatus?.()
          if (firebaseSync && st?.configured && st?.signedIn) {
            const cloudMeta = await firebaseSync.downloadMeta()
            if (cloudMeta) {
              const cur = g.getSnapshot()
              g.setSnapshot(applyCloudMetaToState(cur, cloudMeta))
            }
          }

          buyOk = Boolean((g as any).buyMetaUpgrade?.(key, amt))
          if (!buyOk) return

          // Persist locally immediately.
          const afterBuy = g.getSnapshot()
          saveSnapshot(config, afterBuy)

          // Push + re-pull meta so Paladyum reflects the DB after spending.
          if (firebaseSync && st?.configured && st?.signedIn) {
            await firebaseSync.uploadMetaFromState(afterBuy)
            const cloudMeta2 = await firebaseSync.downloadMeta()
            if (cloudMeta2) {
              const cur2 = g.getSnapshot()
              g.setSnapshot(applyCloudMetaToState(cur2, cloudMeta2))
            }
          }

          const finalSnap = g.getSnapshot()
          saveSnapshot(config, finalSnap)
          lastState = finalSnap
        })

        if (!buyOk) {
          flashFail(elBtn)
          return
        }

        overlay.remove()
        void showMetaUpgradesModal()
      }

      b1.onclick = () => void doBuy(1, b1)
      b10.onclick = () => void doBuy(10, b10)
      bM.onclick = () => void doBuy('max', bM)

      controls.append(b1, b10, bM)
      cb.append(info, controls)
      card.append(ch, cb)
      return card
    }

    if (upgradesTab === 'attack') {
      b.append(renderMetaRow('Damage', 'damage'))
      b.append(renderMetaRow('Attack Speed', 'fireRate'))
      b.append(renderMetaRow('Crit', 'crit'))
      b.append(renderMetaRow('Multi-shot', 'multiShot'))
      b.append(renderMetaRow('Armor Piercing', 'armorPierce'))
    } else if (upgradesTab === 'defense') {
      b.append(renderMetaRow('Base HP', 'baseHP'))
      b.append(renderMetaRow('Slow Field', 'slow'))
      b.append(renderMetaRow('Fortify (Escape DR)', 'fortify'))
      b.append(renderMetaRow('Repair (Regen)', 'repair'))
    } else {
      b.append(renderMetaRow('Range', 'range'))
      b.append(renderMetaRow('Gold Finder', 'gold'))
    }

    modal.append(h, b)

    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) overlay.remove()
    })
  }

  function renderLogin() {
    const panel = el('div', 'panel')
    panel.style.maxWidth = '560px'
    panel.style.margin = 'auto'
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Login'

    const back = btn('Back', 'btn')
    back.onclick = () => setScreen('menu')
    header.appendChild(back)

    const body = el('div', 'panel-body')

    const st = firebaseSync?.getStatus()
    const statusLine = el('div', 'muted')
    if (!firebaseSync) {
      statusLine.textContent = 'Account sync unavailable.'
    } else if (!st?.configured) {
      statusLine.textContent = 'Firebase not configured. Add VITE_FIREBASE_* env vars and reload.'
    } else {
      statusLine.textContent = `Status: ${st.signedIn ? `Signed in as ${st.email ?? 'user'}` : 'Signed out'}`
    }

    if (st?.signedIn) {
      const note = el('div', 'muted')
      note.style.marginTop = '8px'
      const uname = authUsername?.trim()
      note.textContent = `Already signed in${uname ? ` as ${uname}` : ''}.`
      body.append(statusLine, note)
      panel.append(header, body)
      center.appendChild(panel)
      return
    }

    const id = document.createElement('input')
    id.type = 'text'
    id.placeholder = 'Username or email…'
    id.value = loginIdentifier
    id.oninput = () => {
      loginIdentifier = id.value
    }

    const pass = document.createElement('input')
    pass.type = 'password'
    pass.placeholder = 'Password…'
    pass.value = loginPassword
    pass.oninput = () => {
      loginPassword = pass.value
    }

    const row1 = el('div', 'stack')
    row1.append(id, pass)

    const actions = el('div', 'stack')
    actions.style.marginTop = '10px'
    const signIn = btn('Sign in', 'btn btn-primary')
    signIn.onclick = async () => {
      try {
        await withLoading(async () => {
          game?.setPaused(true)
          await firebaseSync?.signInUsernameOrEmail(loginIdentifier, loginPassword)
          await maybeInitialCloudSync()
        })
        alert('Signed in.')
        setScreen('menu')
      } catch (e) {
        alert(String((e as any)?.message ?? e))
      }
    }

    actions.append(signIn)

    const note = el('div', 'muted')
    note.style.marginTop = '8px'
    note.textContent = 'Use your username or email.'

    body.append(statusLine, row1, actions, note)
    panel.append(header, body)
    center.appendChild(panel)
  }

  function renderHUD(overlayActive: boolean) {
    const state = lastState
    if (!state) return
    const sim = getSimOrFallback(state)

    const topPanel = el('div', 'panel')
    const bar = el('div', 'hud-topbar')

    const timeLeft = Math.max(0, config.sim.waveDurationSec - sim.waveTimeSec)

    bar.append(
      kv('Wave', String(state.wave), true),
      kv('Time', formatTimeMMSS(timeLeft), true),
      kv('Gold', formatNumber(state.gold, state.settings.numberFormat), true),
      kv('Paladyum (Run)', formatPaladyumInt(state.stats.paladyumDroppedThisRun ?? 0), true),
      kv('DPS (snap)', formatNumber(sim.wave.dpsSnap, state.settings.numberFormat), true),
      kv('HP', `${formatNumber(state.baseHP, 'suffix')}`, true),
    )

    const body = el('div', 'panel-body')

    // Kill ratio bar
    const kr = sim.spawnedSoFar <= 0 ? 0 : clamp(sim.killed / Math.max(1, sim.spawnedSoFar), 0, 1)
    const th = sim.wave.threshold
    const { penaltyFactor } = calcPenaltyFactor(kr, th, config)

    const line = el('div', 'hud-kpi')

    const left = el('div', 'hud-kpi-block')
    left.innerHTML = `<div class="muted hud-kpi-label">Kill Ratio</div><div class="mono hud-kpi-value">${kr.toFixed(2)} <span class="muted">/ Target ${th.toFixed(2)}</span></div>`

    const right = el('div', 'hud-kpi-block hud-kpi-right')
    right.innerHTML = `<div class="muted hud-kpi-label">Penalty Multiplier</div><div class="mono hud-kpi-value" style="color:${penaltyFactor < 1 ? 'var(--danger)' : 'var(--neon-lime)'}">x${penaltyFactor.toFixed(2)}</div>`

    line.append(left, right)

    const barOuter = el('div', 'bar' + (penaltyFactor < 1 ? ' warn' : ''))
    const fill = el('div', 'fill')
    fill.style.width = `${Math.floor(kr * 100)}%`
    barOuter.appendChild(fill)

    body.append(line, barOuter)

    // Daily contracts progress (in-game display)
    const nowUTC = Date.now()
    const contractsInfo = getDailyContracts({ state, config, nowUTC })
    if (contractsInfo.state !== state && game) {
      lastState = contractsInfo.state
      game.setSnapshot(contractsInfo.state, 'soft')
    }

    const lang = (lastState?.settings as any)?.language === 'tr' ? 'tr' : 'en'
    const contractsBox = el('div', 'hud-contracts')

    const doneCount = contractsInfo.contracts.filter((c) => c.completed).length
    const claimedCount = contractsInfo.contracts.filter((c) => c.claimed).length
    const contractsTitle = el('div', 'muted')
    contractsTitle.style.fontWeight = '900'
    contractsTitle.style.marginTop = '8px'
    contractsTitle.innerHTML = `${lang === 'tr' ? 'Günlük Kontratlar' : 'Daily Contracts'}: <span class="mono">${doneCount}/${contractsInfo.contracts.length}</span> ${lang === 'tr' ? 'tamamlandı' : 'completed'} • <span class="mono">${claimedCount}/${contractsInfo.contracts.length}</span> ${lang === 'tr' ? 'alındı' : 'claimed'}`

    const list = el('div', 'muted')
    list.style.fontSize = '12px'
    list.style.marginTop = '6px'

    for (const c of contractsInfo.contracts) {
      const line = el('div')
      const name = lang === 'tr' ? c.titleTR : c.titleEN
      const status = c.claimed ? (lang === 'tr' ? 'ALINDI' : 'CLAIMED') : c.completed ? (lang === 'tr' ? 'HAZIR' : 'READY') : ''
      const statusColor = c.claimed ? 'var(--muted)' : c.completed ? 'var(--neon-lime)' : 'var(--muted)'
      const statusHtml = status ? ` <span class="mono" style="color:${statusColor}">[${status}]</span>` : ''
      line.innerHTML = `• ${name}: <span class="mono">${formatNumber(c.progress, lastState?.settings.numberFormat ?? 'suffix')}</span>/<span class="mono">${formatNumber(c.goal, lastState?.settings.numberFormat ?? 'suffix')}</span>${statusHtml}`
      list.appendChild(line)
    }

    contractsBox.append(contractsTitle, list)
    body.appendChild(contractsBox)
    topPanel.append(bar, body)
    top.appendChild(topPanel)

    // Bottom bar
    const bottomPanel = el('div', 'panel')
    const bb = el('div', 'bottom-bar')

    const leftStack = el('div', 'stack')
    const speed1 = btn('1x', 'btn')
    const speed2 = btn('2x', 'btn')
    const speed3 = btn('3x', 'btn')
    ;[speed1, speed2, speed3].forEach((b) => (b.style.minWidth = '42px'))

    const markSpeed = (button: HTMLButtonElement, active: boolean) => {
      button.classList.toggle('is-selected', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
    markSpeed(speed1, sim.timeScale === 1)
    markSpeed(speed2, sim.timeScale === 2)
    markSpeed(speed3, sim.timeScale === 3)

    speed1.onclick = () => game?.setTimeScale(1)
    speed2.onclick = () => game?.setTimeScale(2)
    speed3.onclick = () => game?.setTimeScale(3)

    const pause = btn(sim.paused ? 'Resume' : 'Pause', 'btn')
    pause.onclick = () => {
      game?.setPaused(!sim.paused)
      render()
    }

    leftStack.append(speed1, speed2, speed3, pause)

    const rightStack = el('div', 'stack')
    const menu = btn('Menu', 'btn')
    menu.onclick = () => {
      void (async () => {
        if (!game) return

        // Freeze gameplay and capture the latest snapshot before leaving HUD.
        game.setPaused(true)
        const snapshot = game.getSnapshot()
        lastState = snapshot

        // Always persist locally; and if signed in, upload meta now so
        // subsequent cloud pulls (e.g., Continue) can't overwrite progress.
        const st = firebaseSync?.getStatus()
        const canCloud = !!firebaseSync && !!st?.configured && !!st?.signedIn

        if (canCloud) {
          try {
            await withLoading(async () => {
              saveSnapshot(config, snapshot)
              await firebaseSync!.uploadMetaFromState(snapshot)
            })
          } catch (e) {
            // If cloud save fails, keep local progress and still go to menu.
            alert(String((e as any)?.message ?? e))
          }
        } else {
          saveSnapshot(config, snapshot)
        }

        setScreen('menu')
      })()
    }

  rightStack.append(menu)

    bb.append(leftStack, rightStack)
    bottomPanel.appendChild(bb)
    bottom.appendChild(bottomPanel)

    // Inline Upgrades + Live Report (compact row)
    if (!overlayActive) {
      const panels = el('div', 'hud-inline-row')

      // --- Upgrades + Live mini-panel ---
      const upg = el('div', 'panel hud-inline-panel')
      const uh = el('div', 'panel-header')
      uh.textContent = 'Upgrades'
      const ub = el('div', 'panel-body')
      ub.appendChild(
        renderUpgradesTabs(() => {
          render()
        }),
      )

      if (upgradesTab === 'attack') {
        ub.appendChild(renderUpgradeRow('Damage', 'damage', state.towerUpgrades.damageLevel))
        ub.appendChild(renderUpgradeRow('Attack Speed', 'fireRate', state.towerUpgrades.fireRateLevel))
        ub.appendChild(renderUpgradeRow('Crit', 'crit', state.towerUpgrades.critLevel))
        ub.appendChild(renderUpgradeRow('Multi-shot', 'multiShot', state.towerUpgrades.multiShotLevel))
        ub.appendChild(renderUpgradeRow('Armor Piercing', 'armorPierce', state.towerUpgrades.armorPierceLevel))
      } else if (upgradesTab === 'defense') {
        ub.appendChild(renderUpgradeRow('Base HP', 'baseHP', state.towerUpgrades.baseHPLevel))
        ub.appendChild(renderUpgradeRow('Slow Field', 'slow', state.towerUpgrades.slowLevel))
        ub.appendChild(renderUpgradeRow('Fortify (Escape DR)', 'fortify', state.towerUpgrades.fortifyLevel))
        ub.appendChild(renderUpgradeRow('Repair (Regen)', 'repair', state.towerUpgrades.repairLevel))
      } else {
        ub.appendChild(renderUpgradeRow('Range', 'range', state.towerUpgrades.rangeLevel))
        ub.appendChild(renderUpgradeRow('Gold Finder', 'gold', state.towerUpgrades.goldLevel))
      }

      const liveTitle = el('div')
      liveTitle.textContent = 'Live'
      liveTitle.style.fontWeight = '800'
      liveTitle.style.marginTop = '4px'

      const live = el('div', 'muted')
      live.style.fontSize = '12px'
      live.innerHTML = `
        <div>Spawn: <span class="mono">${sim.spawnedSoFar}/${sim.wave.spawnCount}</span></div>
        <div>Killed: <span class="mono">${sim.killed}</span> · Escaped: <span class="mono">${sim.escaped}</span></div>
      `

      const t = computeTowerUIStats(state)
      const statsBox = el('div', 'muted')
      statsBox.style.fontSize = '12px'
      statsBox.style.marginTop = '6px'

      const critText =
        !Number.isFinite(t.crit.everyN) || t.crit.everyN === Number.POSITIVE_INFINITY
          ? '—'
          : `1/${Math.floor(t.crit.everyN)} ×${t.crit.mult.toFixed(2)}`
      const invText = t.invulnDurationSec > 0 && t.invulnCooldownSec > 0 ? `${t.invulnDurationSec.toFixed(2)}s / ${t.invulnCooldownSec.toFixed(0)}s` : '—'
      statsBox.innerHTML = `
        <div>DPS: <span class="mono">${formatNumber(t.dps, state.settings.numberFormat)}</span></div>
        <div>Damage/shot: <span class="mono">${formatNumber(t.damagePerShot, state.settings.numberFormat)}</span></div>
        <div>Fire rate: <span class="mono">${t.fireRateFinal.toFixed(2)}/s</span></div>
        <div>Range: <span class="mono">${Math.floor(t.rangeFinal)}</span></div>
        <div>Targets: <span class="mono">${t.targetsFinal}</span></div>
        <div>Crit: <span class="mono">${critText}</span></div>
        <div>Armor Pierce: <span class="mono">${formatPct(t.armorPierceFinal)}</span></div>
        <div>Max HP: <span class="mono">${formatNumber(t.maxHP, state.settings.numberFormat)}</span></div>
        <div>Regen: <span class="mono">${formatPct(t.repairPct)}/s</span></div>
        <div>Gold Mult: <span class="mono">x${t.goldMultFinal.toFixed(2)}</span></div>
        <div>Invuln: <span class="mono">${invText}</span></div>
      `

      ub.append(hr(), liveTitle, live, statsBox)
      upg.append(uh, ub)

      // --- Modules (applied effects) mini-panel ---
      const modsPanel = el('div', 'panel hud-inline-panel')
      // Push the modules panel to the right within the HUD inline row.
      modsPanel.style.marginLeft = 'auto'
      const mh = el('div', 'panel-header')
      mh.textContent = 'Modules (Active)'
      const mb = el('div', 'panel-body')

      const pctSigned = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
      const numSigned = (v: number) => `${v >= 0 ? '+' : ''}${Math.floor(v)}`

      const maxSlots = Math.max(1, Math.floor(config.modules.slotCount))
      const unlockedSlots = Math.max(1, Math.min(maxSlots, Math.floor(state.moduleSlotsUnlocked ?? 1)))

      const inv = el('div', 'muted')
      inv.style.fontSize = '12px'

      const anyEquipped = (() => {
        for (let slot = 1; slot <= unlockedSlots; slot++) {
          if (state.modulesEquipped[slot]) return true
        }
        return false
      })()

      const pct = (v: number) => `${(v * 100).toFixed(1)}%`

      if (!anyEquipped) {
        inv.appendChild(el('div', 'muted')).textContent = 'No modules equipped.'
      } else {
        for (let slot = 1; slot <= unlockedSlots; slot++) {
          const id = state.modulesEquipped[slot]
          if (!id) continue

          const def = config.modules.defs.find((d) => d.id === id)
          const rawLevel = Math.max(1, Math.floor(state.moduleLevels[id] ?? 1))
          const levelCap =
            def && typeof def.maxEffectiveLevel === 'number' && Number.isFinite(def.maxEffectiveLevel)
              ? Math.max(0, Math.floor(def.maxEffectiveLevel))
              : rawLevel
          const L = Math.min(rawLevel, levelCap)
          const name = def?.nameTR ?? id

          const header = el('div', 'mono')
          header.textContent = `S${slot}: ${name} (Lv ${rawLevel}${L !== rawLevel ? ` → ${L}` : ''})`
          header.style.fontWeight = '800'
          header.style.marginTop = '4px'

          const details = el('div', 'muted')
          details.style.marginLeft = '0px'

          if (!def || L <= 0) {
            details.textContent = '—'
          } else {
            const parts: string[] = []

            if (def.dmgMultPerLevel) parts.push(`Damage Mult: x${(1 + def.dmgMultPerLevel * L).toFixed(2)}`)
            if (def.dmgFlatPerLevel) parts.push(`Flat Damage: ${def.dmgFlatPerLevel >= 0 ? '+' : ''}${(def.dmgFlatPerLevel * L).toFixed(0)}`)
            if (def.fireRateBonusPerLevel) parts.push(`Fire Rate: ${def.fireRateBonusPerLevel >= 0 ? '+' : ''}${pct(def.fireRateBonusPerLevel * L)}`)
            if (def.rangeBonusPerLevel) parts.push(`Range: ${def.rangeBonusPerLevel >= 0 ? '+' : ''}${(def.rangeBonusPerLevel * L).toFixed(0)}`)
            if (def.armorPiercePerLevel) parts.push(`Armor Pierce: ${def.armorPiercePerLevel >= 0 ? '+' : ''}${pct(def.armorPiercePerLevel * L)}`)
            if (def.baseHPBonusPerLevel) parts.push(`Base HP: ${def.baseHPBonusPerLevel >= 0 ? '+' : ''}${(def.baseHPBonusPerLevel * L).toFixed(0)}`)
            if (def.baseHPMultPerLevel) parts.push(`Max HP Mult: x${(1 + def.baseHPMultPerLevel * L).toFixed(2)}`)
            if (def.goldMultPerLevel) parts.push(`Gold Mult: x${(1 + def.goldMultPerLevel * L).toFixed(2)}`)

            if (def.shotCountPerLevel) {
              const add = Math.max(0, Math.floor(def.shotCountPerLevel * L))
              if (add > 0) parts.push(`Ability: Multi-shot (+${add} targets)`)
            }
            if (def.invulnDurationSecPerLevel && def.invulnCooldownSec) {
              const dur = Math.max(0, def.invulnDurationSecPerLevel * L)
              if (dur > 0) parts.push(`Ability: Escape Invuln (${dur.toFixed(2)}s / ${def.invulnCooldownSec.toFixed(0)}s)`)
            }

            details.textContent = parts.length ? parts.join(' • ') : '—'
          }

          inv.append(header, details)
        }
      }

      const agg = aggregateModules(state, config)

      const effects = el('div', 'muted')
      effects.style.fontSize = '12px'
      effects.style.marginTop = '6px'

      const effectLines: string[] = []
      if (agg.dmgMult !== 1) effectLines.push(`Damage Mult: <span class="mono">x${agg.dmgMult.toFixed(2)}</span>`)
      if (agg.dmgFlat !== 0) effectLines.push(`Flat Damage: <span class="mono">${numSigned(agg.dmgFlat)}</span>`)
      if (agg.fireRateBonus !== 0) effectLines.push(`Fire Rate: <span class="mono">${pctSigned(agg.fireRateBonus)}</span>`)
      if (agg.rangeBonus !== 0) effectLines.push(`Range: <span class="mono">${numSigned(agg.rangeBonus)}</span>`)
      if (agg.baseHPBonus !== 0) effectLines.push(`Base HP: <span class="mono">${numSigned(agg.baseHPBonus)}</span>`)
      if (agg.baseHPMult !== 1) effectLines.push(`Max HP Mult: <span class="mono">x${agg.baseHPMult.toFixed(2)}</span>`)
      if (agg.goldMult !== 1) effectLines.push(`Gold Mult: <span class="mono">x${agg.goldMult.toFixed(2)}</span>`)
      if (agg.armorPierce !== config.tower.armorPierce0) effectLines.push(`Armor Pierce: <span class="mono">${formatPct(agg.armorPierce)}</span>`)

      if (agg.shotCount > 1) effectLines.push(`Ability: <span class="mono">Multi-shot</span> (${agg.shotCount} targets)`)
      if (Number.isFinite(agg.critEveryN) && agg.critEveryN !== Number.POSITIVE_INFINITY && agg.critMult > 1.000001) {
        effectLines.push(`Ability: <span class="mono">Crit</span> (every ${Math.max(2, Math.floor(agg.critEveryN))} shots, x${agg.critMult.toFixed(2)})`)
      }
      if (agg.enemySpeedMult !== 1) {
        effectLines.push(`Enemy Speed: <span class="mono">x${agg.enemySpeedMult.toFixed(2)}</span>`)
      }
      if (agg.invulnDurationSec > 0 && agg.invulnCooldownSec > 0) {
        effectLines.push(
          `Ability: <span class="mono">Invuln vs escapes</span> (${agg.invulnDurationSec.toFixed(2)}s / ${agg.invulnCooldownSec.toFixed(0)}s)`,
        )
      }

      effects.innerHTML = effectLines.length ? effectLines.map((t) => `<div>${t}</div>`).join('') : `<div class="muted">No active bonuses.</div>`

      mb.append(inv, hr(), effects)
      modsPanel.append(mh, mb)

      panels.append(upg, modsPanel)
      center.appendChild(panels)
    }
  }

  function buildTowerPanel(args: { backLabel: string; onBack: () => void }) {
    const panel = el('div', 'panel')
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Tower Stats'

    const back = btn(args.backLabel, 'btn')
    back.onclick = args.onBack
    header.appendChild(back)

    const body = el('div', 'panel-body')

    if (!lastState) {
      body.appendChild(el('div', 'muted')).textContent = 'No tower stats available.'
      panel.append(header, body)
      return panel
    }

    const t = computeTowerUIStats(lastState)

    const critText =
      !Number.isFinite(t.crit.everyN) || t.crit.everyN === Number.POSITIVE_INFINITY
        ? '—'
        : `1/${Math.floor(t.crit.everyN)} ×${t.crit.mult.toFixed(2)}`
    const critAvgText = `x${t.critAvg.toFixed(3)}`
    const invText = t.invulnDurationSec > 0 && t.invulnCooldownSec > 0 ? `${t.invulnDurationSec.toFixed(2)}s / ${t.invulnCooldownSec.toFixed(0)}s` : '—'

    body.append(
      kv('DPS', formatNumber(t.dps, lastState.settings.numberFormat), true),
      kv('Damage/shot', formatNumber(t.damagePerShot, lastState.settings.numberFormat), true),
      kv('Fire rate', `${t.fireRateFinal.toFixed(3)}/s`, true),
      kv('Range', String(Math.floor(t.rangeFinal)), true),
      kv('Targets', String(t.targetsFinal), true),
      kv('Crit', `${critText} (avg ${critAvgText})`, true),
      kv('Armor Pierce', formatPct(t.armorPierceFinal), true),
      kv('Max HP', formatNumber(t.maxHP, lastState.settings.numberFormat), true),
      kv('Regen', `${formatPct(t.repairPct)}/s`, true),
      kv('Slow (enemy speed mult)', t.slowFinalMult.toFixed(3), true),
      kv('Escape Damage Mult', t.escapeDamageMult.toFixed(3), true),
      kv('Gold Mult', `x${t.goldMultFinal.toFixed(3)}`, true),
      kv('Invulnerability', invText, true),
    )

    body.appendChild(hr())

    const breakdown = el('div', 'muted')
    breakdown.style.fontSize = '12px'
    breakdown.innerHTML = `<div style="font-weight:800">Breakdown</div>`

    const apFromModules = t.mods.armorPierce - config.tower.armorPierce0
    const slowFromModules = t.mods.enemySpeedMult

    const row = (label: string, text: string) => {
      const d = el('div', 'muted')
      d.innerHTML = `• <span style="font-weight:800">${label}:</span> ${text}`
      return d
    }

    breakdown.append(
      row(
        'Damage/shot',
        `base ${formatNumber(t.baseDamage, lastState!.settings.numberFormat)} × mods ${t.mods.dmgMult.toFixed(3)} ${t.mods.dmgFlat >= 0 ? '+' : ''}${t.mods.dmgFlat.toFixed(1)} = <span class="mono">${formatNumber(t.damagePerShot, lastState!.settings.numberFormat)}</span>`,
      ),
      row(
        'Fire rate',
        `base ${t.fireRateBase.toFixed(3)}/s × (1 ${t.mods.fireRateBonus >= 0 ? '+' : ''}${(t.mods.fireRateBonus * 100).toFixed(1)}%) = <span class="mono">${t.fireRateFinal.toFixed(3)}/s</span>`,
      ),
      row(
        'Range',
        `base ${Math.floor(t.rangeBase)} ${t.mods.rangeBonus >= 0 ? '+' : ''}${t.mods.rangeBonus.toFixed(1)} (mods) = <span class="mono">${Math.floor(t.rangeFinal)}</span>`,
      ),
      row(
        'Armor Pierce',
        `base ${formatPct(config.tower.armorPierce0)} ${apFromModules >= 0 ? '+' : ''}${(apFromModules * 100).toFixed(1)}% (mods) + ${formatPct(t.armorPierceBonus)} (upgrade) = <span class="mono">${formatPct(t.armorPierceFinal)}</span>`,
      ),
      row(
        'Targets',
        `max(upgrade ${t.baseTargets}, mods ${t.mods.shotCount}) = <span class="mono">${t.targetsFinal}</span>`,
      ),
      row(
        'Max HP',
        `baseHP track uses mods: +${t.mods.baseHPBonus.toFixed(1)} and ×${t.mods.baseHPMult.toFixed(3)} ⇒ <span class="mono">${formatNumber(t.maxHP, lastState!.settings.numberFormat)}</span>`,
      ),
      row(
        'Slow',
        `upgrade ${t.slowBaseMult.toFixed(3)} × mods ${slowFromModules.toFixed(3)} = <span class="mono">${t.slowFinalMult.toFixed(3)}</span>`,
      ),
      row(
        'Gold Mult',
        `upgrade x${towerGoldMult(lastState!, config).toFixed(3)} × mods x${t.mods.goldMult.toFixed(3)} = <span class="mono">x${t.goldMultFinal.toFixed(3)}</span>`,
      ),
    )

    body.appendChild(breakdown)

    body.appendChild(hr())

    const modsTitle = el('div')
    modsTitle.style.fontWeight = '800'
    modsTitle.textContent = 'Modules (Active Effects)'
    body.appendChild(modsTitle)

    const maxSlots = Math.max(1, Math.floor(config.modules.slotCount))
    const unlockedSlots = Math.max(1, Math.min(maxSlots, Math.floor(lastState.moduleSlotsUnlocked ?? 1)))
    let anyEquipped = false
    for (let slot = 1; slot <= unlockedSlots; slot++) {
      const id = lastState.modulesEquipped[slot]
      if (!id) continue
      anyEquipped = true

      const def = config.modules.defs.find((d) => d.id === id)
      const rawLevel = Math.max(1, Math.floor(lastState.moduleLevels[id] ?? 1))

      const title = el('div', 'mono')
      title.style.fontWeight = '800'
      title.style.marginTop = '6px'
      title.textContent = `S${slot}: ${def?.nameTR ?? id} (Lv ${rawLevel})`

      const effect = el('div', 'muted')
      effect.style.fontSize = '12px'
      effect.textContent = def ? moduleEffectText(def, rawLevel, config) : '—'

      body.append(title, effect)
    }
    if (!anyEquipped) {
      const none = el('div', 'muted')
      none.style.fontSize = '12px'
      none.textContent = 'No modules equipped.'
      body.appendChild(none)
    }

    panel.append(header, body)
    return panel
  }

  function showTowerModal() {
    const panel = buildTowerPanel({
      backLabel: 'Close',
      onBack: () => overlay.remove(),
    })
    panel.style.width = 'min(920px, calc(100vw - 20px))'

    const overlay = mountModal(panel)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) overlay.remove()
    })
  }

  function renderUpgradesTabs(onChanged: () => void): HTMLElement {
    const row = el('div', 'stack')
    row.style.marginBottom = '10px'
    row.style.flexWrap = 'wrap'

    const mk = (label: string, value: typeof upgradesTab) => {
      const b = btn(label, 'btn')
      const active = upgradesTab === value
      b.classList.toggle('is-selected', active)
      b.setAttribute('aria-pressed', active ? 'true' : 'false')
      b.onclick = () => {
        upgradesTab = value
        onChanged()
      }
      return b
    }

    row.append(mk('Attack', 'attack'), mk('Defense', 'defense'), mk('Utility', 'utility'))
    return row
  }

  function renderUpgradeRow(
    label: string,
    key: TowerUpgradeKey,
    level: number,
  ): HTMLElement {
    const box = el('div')
    box.style.display = 'grid'
    box.style.gridTemplateColumns = '1fr auto'
    box.style.gap = '10px'
    box.style.alignItems = 'center'
    box.style.marginBottom = '10px'

    const left = el('div')
    const maxL = upgradeMaxLevel(key, config)
    const atMax = level >= maxL
    const nextCost = atMax ? 'MAX' : formatNumber(upgradeCost(key, level, config), lastState?.settings.numberFormat ?? 'suffix')
    left.innerHTML = `<div style="font-weight:800">${label}</div><div class="muted mono">Lv ${level}${Number.isFinite(maxL) ? ` / ${maxL}` : ''} • Next:</div><div class="mono" style="font-weight:800">${nextCost}</div>`

    const controls = el('div', 'stack')
    const b1 = btn('+1', 'btn')
    const b10 = btn('+10', 'btn')
    const bM = btn('+Max', 'btn')

    const gold = Math.max(0, Number(lastState?.gold ?? 0))
    const canAffordN = (n: number) => {
      if (atMax) return false
      let total = 0
      for (let i = 0; i < n; i++) {
        const L = level + i
        if (L >= maxL) return false
        total += upgradeCost(key, L, config)
        if (!Number.isFinite(total) || gold < total) return false
      }
      return true
    }

    if (atMax) {
      b1.disabled = true
      b10.disabled = true
      bM.disabled = true
    } else {
      b1.disabled = !canAffordN(1)
      b10.disabled = !canAffordN(10)
      // "Max" buys as many as possible, so enable if at least one is affordable.
      bM.disabled = !canAffordN(1)
    }

    b1.onclick = () => {
      if (!game) {
        flashFail(b1)
        return
      }
      const ok = game.buyUpgrade(key, 1)
      if (!ok) {
        flashFail(b1)
        return
      }
      lastState = game.getSnapshot()
      render()
    }
    b10.onclick = () => {
      if (!game) {
        flashFail(b10)
        return
      }
      const ok = game.buyUpgrade(key, 10)
      if (!ok) {
        flashFail(b10)
        return
      }
      lastState = game.getSnapshot()
      render()
    }
    bM.onclick = () => {
      if (!game) {
        flashFail(bM)
        return
      }
      const ok = game.buyUpgrade(key, 'max')
      if (!ok) {
        flashFail(bM)
        return
      }
      lastState = game.getSnapshot()
      render()
    }

    controls.append(b1, b10, bM)
    box.append(left, controls)
    return box
  }

  function buildModulesPanel(args: {
    backLabel: string
    onBack: () => void
    rerender: () => void
  }): HTMLElement {
    if (!game || !lastState) return el('div')

    const g = game

    const panel = el('div', 'panel')
    panel.style.maxWidth = '1180px'
    panel.style.margin = '0 auto'
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Modules'

    const back = btn(args.backLabel, 'btn')
    back.onclick = () => args.onBack()
    header.appendChild(back)

    const body = el('div', 'panel-body')

    const layout = el('div', 'ng-modules-layout')

    const bal = el('div', 'muted ng-modules-balance')
    bal.innerHTML = `Paladyum: <span class="mono">${formatPaladyumInt(lastState.points)}</span>`

    const renderEffectList = (text: string): HTMLElement => {
      const ul = document.createElement('ul')
      ul.className = 'ng-mod-effect'
      const lines = String(text || '')
        .split(' • ')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const line of lines) {
        const li = document.createElement('li')
        li.textContent = line
        ul.appendChild(li)
      }
      return ul
    }

    // Slots / Equip
    const slotsPanel = el('div', 'panel')
    const sh = el('div', 'panel-header')
    sh.textContent = 'Slots'
    const sb = el('div', 'panel-body')

    const maxSlots = Math.max(1, Math.floor(config.modules.slotCount))
    const unlockedSlots = Math.max(1, Math.min(maxSlots, Math.floor(lastState.moduleSlotsUnlocked ?? 1)))

    const meta = el('div', 'muted')
    meta.style.marginBottom = '8px'
    meta.textContent = `Unlocked slots: ${unlockedSlots} / ${maxSlots}`
    sb.appendChild(meta)

    const unlockedDefs = config.modules.defs.filter((d) => !!lastState!.modulesUnlocked[d.id])
    unlockedDefs.sort((a, b) => (a.category + a.nameTR).localeCompare(b.category + b.nameTR))

    const equippedIds = new Set<string>()
    const equippedById = new Map<string, number>()
    for (let s = 1; s <= maxSlots; s++) {
      const id = lastState.modulesEquipped[s]
      if (id) {
        equippedIds.add(id)
        if (!equippedById.has(id)) equippedById.set(id, s)
      }
    }

    const firstEmptyUnlockedSlot = (): number | null => {
      for (let s = 1; s <= unlockedSlots; s++) {
        if (!lastState!.modulesEquipped[s]) return s
      }
      return null
    }

    const shouldCloudSyncOnEquip = () => {
      if (!firebaseSync) return false
      const st = firebaseSync.getStatus()
      return !!st.configured && !!st.signedIn
    }

    const persistMetaAfterLocalChange = async () => {
      const snapshot = g.getSnapshot()
      saveSnapshot(config, snapshot)
      if (shouldCloudSyncOnEquip()) {
        await firebaseSync!.uploadMetaFromState(snapshot)
      }
    }

    const setEquip = async (slot: number, id: string | null): Promise<boolean> => {
      if (!game) return false

      const doLocal = () => {
        const ok = game!.equipModule(slot, id)
        if (!ok) return false
        lastState = game!.getSnapshot()
        return true
      }

      // If signed-in, treat equip/unequip as a meta change that should be
      // persisted immediately (and show loading until done).
      if (shouldCloudSyncOnEquip()) {
        try {
          const ok = await withLoading(async () => {
            const localOk = doLocal()
            if (!localOk) return false
            await firebaseSync!.uploadMetaFromState(game!.getSnapshot())
            return true
          })
          args.rerender()
          return ok
        } catch (e) {
          alert(String((e as any)?.message ?? e))
          lastState = game.getSnapshot()
          args.rerender()
          return false
        }
      }

      const ok = doLocal()
      if (ok) args.rerender()
      return ok
    }

    const slotsGrid = el('div', 'ng-modules-slots-grid')

    const getModuleLabel = (id: string) => {
      const def = config.modules.defs.find((d) => d.id === id)
      const L = Math.max(1, Math.floor(lastState!.moduleLevels[id] ?? 1))
      return def ? `${def.nameTR} (Lv ${L})` : `${id} (Lv ${L})`
    }

    for (let s = 1; s <= maxSlots; s++) {
      const slotBox = el('div', 'panel')
      slotBox.style.cursor = s <= unlockedSlots ? 'default' : 'not-allowed'
      ;(slotBox as any).dataset.ngSlot = String(s)

      const equippedId = lastState.modulesEquipped[s] ?? null

      const hh = el('div', 'panel-header')
      const left = el('div')
      left.textContent = `Slot ${s}`
      const right = el('div')
      hh.append(left, right)

      const bb = el('div', 'panel-body')
      bb.style.minHeight = '56px'
      if (s <= unlockedSlots) {
        bb.textContent = ''

        if (!equippedId) {
          const empty = el('div', 'mono')
          empty.textContent = 'Empty'
          bb.appendChild(empty)

          const hint = el('div', 'muted')
          hint.style.fontSize = '12px'
          hint.style.marginTop = '6px'
          hint.textContent = 'Use “Add” on a module card.'
          bb.appendChild(hint)
        } else {
          const def = config.modules.defs.find((d) => d.id === equippedId)

          const title = el('div', 'mono')
          title.style.marginBottom = '6px'
          title.textContent = getModuleLabel(equippedId)

          const effect = el('div', 'muted')
          effect.style.fontSize = '12px'
          const effectText = def ? moduleEffectText(def, Math.max(1, Math.floor(lastState!.moduleLevels[equippedId] ?? 1)), config) : ''
          bb.append(title, renderEffectList(effectText))

          const remove = btn('Remove', 'btn btn-danger')
          remove.onclick = (e) => {
            e.stopPropagation()
            if (Date.now() - lastSlotDropAtMs < 250) return
            void setEquip(s, null)
          }
          right.appendChild(remove)
        }
      } else {
        bb.textContent = 'Locked'
        bb.classList.add('muted')

        const label = el('div', 'muted mono')
        label.textContent = 'LOCKED'
        right.appendChild(label)
      }

      slotBox.append(hh, bb)
      slotsGrid.appendChild(slotBox)
    }

    panel.ondragover = null
    panel.ondrop = null

    sb.appendChild(slotsGrid)

    if (unlockedSlots < maxSlots) {
      const cost = moduleSlotUnlockCostPoints(unlockedSlots, config)
      const buy = btn(`Buy Slot (${formatPaladyumInt(cost)} Paladyum)`, 'btn btn-primary')
      buy.style.marginTop = '10px'
      buy.onclick = () => {
        void (async () => {
          const doLocal = () => {
            const ok = g.unlockModuleSlot()
            if (!ok) return false
            lastState = g.getSnapshot()
            return true
          }

          if (shouldCloudSyncOnEquip()) {
            try {
              const ok = await withLoading(async () => {
                const localOk = doLocal()
                if (!localOk) return false
                await persistMetaAfterLocalChange()
                return true
              })
              if (!ok) flashFail(buy)
              args.rerender()
              return
            } catch (e) {
              alert(String((e as any)?.message ?? e))
              lastState = g.getSnapshot()
              args.rerender()
              return
            }
          }

          const ok = doLocal()
          if (!ok) {
            flashFail(buy)
            return
          }
          await persistMetaAfterLocalChange()
          args.rerender()
        })()
      }
      sb.appendChild(buy)
    }

    slotsPanel.append(sh, sb)

    // Filter row
    const toolbar = el('div', 'ng-modules-toolbar')
    const filters = el('div', 'ng-modules-filters')
    const mkFilter = (label: string, f: typeof modulesFilter) => {
      const b = btn(label, 'btn')
      if (modulesFilter === f) b.classList.add('is-selected')
      b.onclick = () => {
        modulesFilter = f
        modulesPage = 0
        args.rerender()
      }
      return b
    }
    filters.append(mkFilter('All', 'ALL'), mkFilter('Offense', 'OFFENSE'), mkFilter('Defense', 'DEFENSE'), mkFilter('Utility', 'UTILITY'))

    // Filter modules
    const filtered = config.modules.defs.filter((d) => modulesFilter === 'ALL' || d.category === modulesFilter)
    const totalPages = Math.max(1, Math.ceil(filtered.length / MODULES_PER_PAGE))
    if (modulesPage >= totalPages) modulesPage = totalPages - 1
    const pageItems = filtered.slice(modulesPage * MODULES_PER_PAGE, (modulesPage + 1) * MODULES_PER_PAGE)

    const unlockedCount = Object.values(lastState.modulesUnlocked).filter(Boolean).length

    const list = el('div', 'ng-modules-grid')

    for (const def of pageItems) {
      const card = el('div', 'panel ng-mod-card')
      card.draggable = false
      card.ondragstart = null
      const ch = el('div', 'panel-header')
      const name = el('div', 'ng-mod-name')
      const label = el('div')
      label.textContent = def.nameTR
      name.append(moduleIcon(def), label)

      const cat = el('div', 'muted mono')
      cat.textContent = def.category
      ch.append(name, cat)

      const cb = el('div', 'panel-body ng-mod-card-body')

      const effectText = moduleEffectText(def, Math.max(1, Math.floor(lastState!.moduleLevels[def.id] ?? 1)), config)
      const effectList = renderEffectList(effectText)

      const actions = el('div', 'ng-mod-actions')

      const isUnlocked = !!lastState.modulesUnlocked[def.id]
      if (!isUnlocked) {
        const cost = moduleUnlockCostPoints(unlockedCount, config)
        const b = btn(`Unlock (${formatPaladyumInt(cost)} Paladyum)`, 'btn btn-primary')
        b.onclick = () => {
          void (async () => {
            const doLocal = () => {
              const ok = g.unlockModule(def.id)
              if (!ok) return false
              lastState = g.getSnapshot()
              return true
            }

            if (shouldCloudSyncOnEquip()) {
              try {
                const ok = await withLoading(async () => {
                  const localOk = doLocal()
                  if (!localOk) return false
                  await persistMetaAfterLocalChange()
                  return true
                })
                if (!ok) flashFail(b)
                args.rerender()
                return
              } catch (e) {
                alert(String((e as any)?.message ?? e))
                lastState = g.getSnapshot()
                args.rerender()
                return
              }
            }

            const ok = doLocal()
            if (!ok) {
              flashFail(b)
              return
            }
            await persistMetaAfterLocalChange()
            args.rerender()
          })()
        }
        const row = el('div', 'ng-mod-actions-row')
        row.appendChild(b)
        actions.appendChild(row)
      } else {
        const eqSlot = equippedById.get(def.id) ?? null
        const add = btn(eqSlot ? `Equipped (S${eqSlot})` : 'Add', eqSlot ? 'btn ng-mod-add' : 'btn btn-primary ng-mod-add')
        add.disabled = !!eqSlot
        add.onclick = () => {
          if (eqSlot) return
          const slot = firstEmptyUnlockedSlot()
          if (!slot) {
            flashFail(add)
            return
          }
          void (async () => {
            const ok = await setEquip(slot, def.id)
            if (!ok) flashFail(add)
          })()
        }

        const level = Math.max(1, Math.floor(lastState.moduleLevels[def.id] ?? 1))
        const cost = moduleUpgradeCostPoints(level, config)

        const points = Math.max(0, Number((lastState as any)?.points ?? 0))
        const canAffordModuleN = (n: number) => {
          let total = 0
          for (let i = 0; i < n; i++) {
            total += moduleUpgradeCostPoints(level + i, config)
            if (!Number.isFinite(total) || points < total) return false
          }
          return true
        }

        const b1 = btn('+1', 'btn')
        b1.disabled = !canAffordModuleN(1)
        b1.onclick = () => {
          void (async () => {
            const doLocal = () => {
              const ok = g.upgradeModule(def.id, 1)
              if (!ok) return false
              lastState = g.getSnapshot()
              return true
            }

            if (shouldCloudSyncOnEquip()) {
              try {
                const ok = await withLoading(async () => {
                  const localOk = doLocal()
                  if (!localOk) return false
                  await persistMetaAfterLocalChange()
                  return true
                })
                if (!ok) flashFail(b1)
                args.rerender()
                return
              } catch (e) {
                alert(String((e as any)?.message ?? e))
                lastState = g.getSnapshot()
                args.rerender()
                return
              }
            }

            const ok = doLocal()
            if (!ok) {
              flashFail(b1)
              return
            }
            await persistMetaAfterLocalChange()
            args.rerender()
          })()
        }
        const b10 = btn('+10', 'btn')
        b10.disabled = !canAffordModuleN(10)
        b10.onclick = () => {
          void (async () => {
            const doLocal = () => {
              const ok = g.upgradeModule(def.id, 10)
              if (!ok) return false
              lastState = g.getSnapshot()
              return true
            }

            if (shouldCloudSyncOnEquip()) {
              try {
                const ok = await withLoading(async () => {
                  const localOk = doLocal()
                  if (!localOk) return false
                  await persistMetaAfterLocalChange()
                  return true
                })
                if (!ok) flashFail(b10)
                args.rerender()
                return
              } catch (e) {
                alert(String((e as any)?.message ?? e))
                lastState = g.getSnapshot()
                args.rerender()
                return
              }
            }

            const ok = doLocal()
            if (!ok) {
              flashFail(b10)
              return
            }
            await persistMetaAfterLocalChange()
            args.rerender()
          })()
        }
        const bM = btn('+Max', 'btn')
        bM.disabled = !canAffordModuleN(1)
        bM.onclick = () => {
          void (async () => {
            const doLocal = () => {
              const ok = g.upgradeModule(def.id, 'max')
              if (!ok) return false
              lastState = g.getSnapshot()
              return true
            }

            if (shouldCloudSyncOnEquip()) {
              try {
                const ok = await withLoading(async () => {
                  const localOk = doLocal()
                  if (!localOk) return false
                  await persistMetaAfterLocalChange()
                  return true
                })
                if (!ok) flashFail(bM)
                args.rerender()
                return
              } catch (e) {
                alert(String((e as any)?.message ?? e))
                lastState = g.getSnapshot()
                args.rerender()
                return
              }
            }

            const ok = doLocal()
            if (!ok) {
              flashFail(bM)
              return
            }
            await persistMetaAfterLocalChange()
            args.rerender()
          })()
        }

        const rowTop = el('div', 'ng-mod-actions-row')
        rowTop.append(add, kv('Level', String(level), true), kv('+1 Cost', formatPaladyumInt(cost), true))

        const rowUp = el('div', 'ng-mod-upgrade-row')
        rowUp.append(b1, b10, bM)

        actions.append(rowTop, rowUp)
      }

      cb.append(effectList, actions)
      card.append(ch, cb)
      list.appendChild(card)
    }

    // Pagination controls
    const pager = el('div', 'hud-pager ng-modules-pager')
    const prevBtn = btn('◀ Prev', 'btn')
    prevBtn.onclick = () => { modulesPage = Math.max(0, modulesPage - 1); args.rerender() }
    if (modulesPage === 0) prevBtn.disabled = true

    const pageLabel = el('div', 'muted mono')
    pageLabel.textContent = `${modulesPage + 1} / ${totalPages}`
    pageLabel.style.fontSize = '13px'

    const nextBtn = btn('Next ▶', 'btn')
    nextBtn.onclick = () => { modulesPage = Math.min(totalPages - 1, modulesPage + 1); args.rerender() }
    if (modulesPage >= totalPages - 1) nextBtn.disabled = true

    pager.append(prevBtn, pageLabel, nextBtn)

    toolbar.append(filters, pager)

    layout.append(bal, slotsPanel, toolbar, list)
    body.append(layout)
    panel.append(header, body)
    return panel
  }

  async function showModulesModal() {
    if (!game || !lastState) return

    const g = game

    const refreshMetaFromCloud = async (opts?: { showSpinner?: boolean }) => {
      const st = firebaseSync?.getStatus()
      const canCloud = !!firebaseSync && !!st?.configured && !!st?.signedIn
      if (!canCloud) return

      const task = async () => {
        await maybeInitialCloudSync()
        const cloudMeta = await firebaseSync!.downloadMeta()
        if (!cloudMeta) {
          // Best-effort: if doc doesn't exist, create it from local.
          await firebaseSync!.uploadMetaFromState(g.getSnapshot())
          return
        }
        const cur = g.getSnapshot()
        g.setSnapshot(applyCloudMetaToState(cur, cloudMeta))
        lastState = g.getSnapshot()
      }

      if (opts?.showSpinner) await withLoading(task)
      else await task()
    }

    // On every open, re-fetch meta from the DB.
    try {
      await refreshMetaFromCloud({ showSpinner: true })
    } catch (e) {
      alert(String((e as any)?.message ?? e))
    }

    const closeAndRefresh = () => {
      overlay.remove()

      // On close, pull again (no spinner) so the menu Paladyum stays in sync.
      void (async () => {
        try {
          await refreshMetaFromCloud()
        } catch {
          // ignore
        } finally {
          render()
        }
      })()
    }

    const panel = buildModulesPanel({
      backLabel: 'Close',
      onBack: () => closeAndRefresh(),
      rerender: () => {
        overlay.remove()
        void showModulesModal()
      },
    })
    panel.style.width = 'min(1240px, calc(100vw - 20px))'

    const overlay = mountModal(panel)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) closeAndRefresh()
    })
  }

  function renderModules() {
    if (!game || !lastState) return
    const panel = buildModulesPanel({
      backLabel: 'Back',
      onBack: () => setScreen('menu'),
      rerender: () => render(),
    })
    center.appendChild(panel)
  }

  function moduleEffectText(def: GameConfig['modules']['defs'][number], rawLevel: number, cfg: GameConfig): string {
    const Lraw = typeof rawLevel === 'number' && Number.isFinite(rawLevel) ? Math.max(1, Math.floor(rawLevel)) : 1
    const cap = typeof def.maxEffectiveLevel === 'number' && Number.isFinite(def.maxEffectiveLevel) ? Math.max(0, Math.floor(def.maxEffectiveLevel)) : Lraw
    const L = Math.min(Lraw, cap)

    const expRaw = (cfg.modules as any).levelExponent
    const exp = typeof expRaw === 'number' && Number.isFinite(expRaw) ? clamp(expRaw, 0.35, 1.0) : 1.0
    const effLevel = L > 0 ? Math.max(0, Math.pow(L, exp)) : 0

    const parts: string[] = []
    parts.push(`Lv ${Lraw}${Lraw > L ? ` (cap ${L})` : ''} • Eff Lv ${effLevel.toFixed(2)}`)
    const pctFromFrac = (frac: number) => `${frac >= 0 ? '+' : ''}${(frac * 100).toFixed(1)}%`
    const ppFromFrac = (frac: number) => `${frac >= 0 ? '+' : ''}${(frac * 100).toFixed(1)}pp`
    const n1 = (v: number) => {
      const vv = Math.abs(v) < 1e-9 ? 0 : v
      const i = Math.round(vv)
      return Math.abs(vv - i) < 1e-6 ? String(i) : vv.toFixed(1)
    }

    if (def.dmgMultPerLevel) parts.push(`Damage: ${pctFromFrac(def.dmgMultPerLevel * effLevel)}`)
    if (def.dmgFlatPerLevel) parts.push(`Flat Damage: ${def.dmgFlatPerLevel * effLevel >= 0 ? '+' : ''}${n1(def.dmgFlatPerLevel * effLevel)}`)
    if (def.fireRateBonusPerLevel) parts.push(`Fire Rate: ${pctFromFrac(def.fireRateBonusPerLevel * effLevel)}`)
    if (def.rangeBonusPerLevel) parts.push(`Range: ${def.rangeBonusPerLevel * effLevel >= 0 ? '+' : ''}${n1(def.rangeBonusPerLevel * effLevel)}`)
    if (def.armorPiercePerLevel) parts.push(`Armor Pierce: ${pctFromFrac(def.armorPiercePerLevel * effLevel)}`)
    if (def.baseHPBonusPerLevel) parts.push(`Base HP: ${def.baseHPBonusPerLevel * effLevel >= 0 ? '+' : ''}${n1(def.baseHPBonusPerLevel * effLevel)}`)
    if (def.baseHPMultPerLevel) parts.push(`Max HP Mult: ${pctFromFrac(def.baseHPMultPerLevel * effLevel)}`)
    if (def.goldMultPerLevel) parts.push(`Gold Mult: ${pctFromFrac(def.goldMultPerLevel * effLevel)}`)

    if (def.pointsMultPerLevel) parts.push(`Paladyum Mult: ${pctFromFrac(def.pointsMultPerLevel * effLevel)}`)

    if (def.thresholdAddPerLevel) parts.push(`KR Target: ${ppFromFrac(def.thresholdAddPerLevel * effLevel)}`)
    if (def.penKMultPerLevel) parts.push(`Penalty K: ${pctFromFrac(def.penKMultPerLevel * effLevel)}`)
    if (def.penMinAddPerLevel) parts.push(`Penalty Min: ${ppFromFrac(def.penMinAddPerLevel * effLevel)}`)
    if (def.spawnCountMultPerLevel) parts.push(`Spawn Count: ${pctFromFrac(def.spawnCountMultPerLevel * effLevel)}`)
    if (def.enemyHpMultPerLevel) parts.push(`Enemy HP: ${pctFromFrac(def.enemyHpMultPerLevel * effLevel)}`)
    if (def.enemyArmorMultPerLevel) parts.push(`Enemy Armor: ${pctFromFrac(def.enemyArmorMultPerLevel * effLevel)}`)

    if (def.shotCountPerLevel) {
      const add = Math.floor(def.shotCountPerLevel * effLevel)
      const capTxt = typeof def.shotCountCap === 'number' && Number.isFinite(def.shotCountCap) ? ` (cap ${Math.max(1, Math.floor(def.shotCountCap))})` : ''
      parts.push(`Ability: Multi-shot (+${Math.max(0, add)} shots)${capTxt}`)
    }
    if (def.invulnDurationSecPerLevel && def.invulnCooldownSec) {
      const dur = Math.max(0, def.invulnDurationSecPerLevel * effLevel)
      parts.push(`Ability: Invuln vs escapes (${dur.toFixed(2)}s, every ${Math.max(0.1, def.invulnCooldownSec)}s)`)
    }

    if (def.critEveryN && def.critMultPerLevel) {
      const n = Math.max(2, Math.floor(def.critEveryN))
      const mult = Math.max(0, def.critMultPerLevel * effLevel)
      parts.push(`Ability: Crit (every ${n} shots, +${(mult * 100).toFixed(1)}% mult)`)
    }

    if (def.enemySpeedMultPerLevel) {
      const delta = def.enemySpeedMultPerLevel * effLevel
      parts.push(`Ability: Enemy Speed ${pctFromFrac(delta)}`)
    }

    if (typeof def.maxEffectiveLevel === 'number' && Number.isFinite(def.maxEffectiveLevel)) {
      const capN = Math.max(0, Math.floor(def.maxEffectiveLevel))
      parts.push(`Balance cap: effective Lv ≤ ${capN}${Lraw > capN ? ` (using Lv ${L})` : ''}`)
    }

    return parts.length ? parts.join(' • ') : 'Effect: (not defined)'
  }

  function moduleIcon(def: GameConfig['modules']['defs'][number]): HTMLSpanElement {
    const icon = el('span', 'ng-mod-icon')
    if (def.category === 'OFFENSE') {
      icon.classList.add('ng-mod-icon-offense')
      icon.textContent = '▲'
    } else if (def.category === 'DEFENSE') {
      icon.classList.add('ng-mod-icon-defense')
      icon.textContent = '■'
    } else {
      icon.classList.add('ng-mod-icon-utility')
      icon.textContent = '◆'
    }

    const concept = (def as any).iconConcept
    icon.title = concept ? `${def.category}: ${String(concept)}` : def.category
    return icon
  }

  function renderSettings() {
    if (!game || !lastState) return

    const panel = buildSettingsPanel({
      backLabel: 'Back',
      onBack: () => setScreen('menu'),
      rerender: () => render(),
    })
    panel.style.maxWidth = '820px'
    panel.style.margin = 'auto'
    center.appendChild(panel)
  }

  function buildSettingsPanel(args: { backLabel: string; onBack: () => void; rerender: () => void }) {
    const panel = el('div', 'panel')
    panel.style.pointerEvents = 'auto'

    // Settings must reflect the latest snapshot (not a potentially stale lastState).
    const getSnap = () => (game ? game.getSnapshot() : lastState)

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Settings'

    const back = btn(args.backLabel, 'btn')
    back.onclick = args.onBack
    header.appendChild(back)

    const body = el('div', 'panel-body')

    let settingsSyncInProgress = false
    let settingsSyncQueued = false
    const canCloudSyncSettings = () => {
      if (!firebaseSync) return false
      const st = firebaseSync.getStatus()
      return !!st.configured && !!st.signedIn
    }
    const persistLocal = () => {
      if (!game) return
      saveSnapshot(config, game.getSnapshot())
    }

    const syncSettingsWithCloud = async (): Promise<void> => {
      if (!canCloudSyncSettings()) return
      if (!game) return

      if (settingsSyncInProgress) {
        settingsSyncQueued = true
        return
      }

      settingsSyncInProgress = true
      try {
        await withLoading(async () => {
          // Upload current local snapshot.
          await firebaseSync!.uploadMetaFromState(game!.getSnapshot())

          // Immediately pull back to confirm & refresh local copy.
          const cloudMeta = await firebaseSync!.downloadMeta()
          if (cloudMeta) {
            const cur = game!.getSnapshot()
            game!.setSnapshot(applyCloudMetaToState(cur, cloudMeta))
            lastState = game!.getSnapshot()
          }
        })
      } finally {
        settingsSyncInProgress = false
        if (settingsSyncQueued) {
          settingsSyncQueued = false
          void syncSettingsWithCloud()
        }
      }
    }

    const audio = el('div')
    audio.innerHTML = `<div style="font-weight:800">Audio</div>`

    const muteRow = el('div')
    muteRow.style.display = 'flex'
    muteRow.style.gap = '10px'
    muteRow.style.alignItems = 'center'
    muteRow.style.marginBottom = '6px'

    const mute = document.createElement('input')
    mute.type = 'checkbox'
    mute.checked = !!((getSnap()?.settings as any)?.audioMuted)
    const muteLabel = el('div', 'muted')
    muteLabel.textContent = 'Mute'
    mute.onchange = () => {
      if (!game) return
      const s = game.getSnapshot()
      const next = {
        ...s,
        settings: { ...s.settings, audioMuted: Boolean(mute.checked) } as any,
      }
      game.setSnapshot(next)
      lastState = game.getSnapshot()
      persistLocal()
      void syncSettingsWithCloud()
    }
    muteRow.append(mute, muteLabel)

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '0'
    slider.max = '1'
    slider.step = '0.01'
    slider.value = String(getSnap()?.settings.audioMaster ?? 1)
    slider.oninput = () => {
      if (!game) return
      const s = game.getSnapshot()
      const next = {
        ...s,
        settings: { ...s.settings, audioMaster: Number(slider.value) },
      }
      game.setSnapshot(next)
      lastState = game.getSnapshot()
      persistLocal()
    }

    slider.onchange = () => {
      if (!game || !lastState) return
      // Only sync to Firestore on release to avoid spamming writes.
      void syncSettingsWithCloud()
    }

    audio.appendChild(slider)
    audio.appendChild(muteRow)

    const nf = el('div')
    nf.style.marginTop = '12px'
    nf.innerHTML = `<div style="font-weight:800">Number Format</div>`

    const nfRow = el('div', 'stack')
    const suf = btn('Suffix', 'btn')
    const sci = btn('Scientific', 'btn')

    const markNF = () => {
      const active = lastState?.settings.numberFormat ?? 'suffix'
      suf.classList.toggle('is-selected', active === 'suffix')
      sci.classList.toggle('is-selected', active === 'scientific')
      suf.setAttribute('aria-pressed', active === 'suffix' ? 'true' : 'false')
      sci.setAttribute('aria-pressed', active === 'scientific' ? 'true' : 'false')
    }
    markNF()

    suf.onclick = () => {
      if (!game) return
      const s = game.getSnapshot()
      const next = {
        ...s,
        settings: { ...s.settings, numberFormat: 'suffix' as const },
      }
      game.setSnapshot(next)
      lastState = game.getSnapshot()
      persistLocal()
      void syncSettingsWithCloud()
      markNF()
      args.rerender()
    }
    sci.onclick = () => {
      if (!game) return
      const s = game.getSnapshot()
      const next = {
        ...s,
        settings: { ...s.settings, numberFormat: 'scientific' as const },
      }
      game.setSnapshot(next)
      lastState = game.getSnapshot()
      persistLocal()
      void syncSettingsWithCloud()
      markNF()
      args.rerender()
    }
    nfRow.append(suf, sci)
    nf.appendChild(nfRow)

    body.append(audio, nf)
    panel.append(header, body)
    return panel
  }

  function showSettingsModal() {
    const panel = buildSettingsPanel({
      backLabel: 'Close',
      onBack: () => overlay.remove(),
      rerender: () => {
        overlay.remove()
        showSettingsModal()
      },
    })
    panel.style.width = 'min(820px, calc(100vw - 20px))'

    const overlay = mountModal(panel)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) overlay.remove()
    })
  }

  function renderStats() {
    if (!lastState) return

    const panel = buildStatsPanel({
      backLabel: 'Back',
      onBack: () => setScreen('menu'),
    })
    panel.style.maxWidth = '920px'
    panel.style.margin = 'auto'
    center.appendChild(panel)
  }

  function buildStatsPanel(args: { backLabel: string; onBack: () => void }) {
    const panel = el('div', 'panel')
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Codex / Stats'

    const back = btn(args.backLabel, 'btn')
    back.onclick = args.onBack
    header.appendChild(back)

    const body = el('div', 'panel-body')

    if (!lastState) {
      body.appendChild(el('div', 'muted')).textContent = 'No stats available.'
      panel.append(header, body)
      return panel
    }

    body.append(
      kv('Total Kills', String(lastState.stats.totalKills), true),
      kv('Total Escapes', String(lastState.stats.totalEscapes), true),
      kv('Best Wave', String(lastState.stats.bestWave), true),
      kv('Runs', String(lastState.stats.runsCount), true),
    )

    body.appendChild(hr())

    const enemy = el('div', 'muted')
    enemy.innerHTML = `<div style="font-weight:800">Enemy Types</div>`
    for (const t of config.enemies.types) {
      const row = el('div', 'muted')
      row.innerHTML = `• <span class="mono">${t.id}</span> — ${t.nameTR} (hp×${t.hpMult}, armor×${t.armorMult})`
      enemy.appendChild(row)
    }

    const formula = el('div', 'muted')
    formula.style.marginTop = '10px'
    formula.innerHTML = `
      <div style="font-weight:800">Deterministic Formulas</div>
      <div class="mono">enemy_type(w,i) = (A·w + B·i + C) mod K</div>
      <div class="mono">t_i = T · (i/N)^p</div>
      <div class="mono">TotalEHP(w) = DPS_snap · T · ρ · G(w)</div>
    `

    body.append(enemy, formula)
    panel.append(header, body)
    return panel
  }

  function showStatsModal() {
    const panel = buildStatsPanel({
      backLabel: 'Close',
      onBack: () => overlay.remove(),
    })
    panel.style.width = 'min(920px, calc(100vw - 20px))'

    const overlay = mountModal(panel)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) overlay.remove()
    })
  }

  function buildHowToPlayPanel(args: { backLabel: string; onBack: () => void }) {
    const panel = el('div', 'panel')
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'How to Play'

    const back = btn(args.backLabel, 'btn')
    back.onclick = args.onBack
    header.appendChild(back)

    const body = el('div', 'panel-body')
    body.style.lineHeight = '1.45'

    body.innerHTML = `
      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">Genre / Summary</div>
        <div>NEON GRID is a <b>wave-based idle / auto-shooter tower defense</b> game.</div>
        <div>Key twist: <b>No RNG</b> — enemies, damage, rewards, and penalties are computed with <b>deterministic</b> formulas.</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">Goal</div>
        <div>Kill as many enemies as possible each wave and keep your <b>Base</b> alive.</div>
        <div>If enemies reach the center and escape, your <b>Base HP</b> drops. When Base HP reaches zero, the run ends.</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">Wave Rules</div>
        <div>• Each wave duration is fixed: <span class="mono">${config.sim.waveDurationSec.toFixed(1)}s</span></div>
        <div>• The tower fires automatically; targeting and shots are controlled by the simulation.</div>
        <div>• When a wave ends, the game pauses; press <b>Continue</b> to start the next wave.</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">Kill Ratio (KR) / Penalty System</div>
        <div>The main performance metric is <b>Kill Ratio</b>. If you fall below the target, you get penalized.</div>
        <div>• Rewards: reduced by the penalty multiplier (gold / meta income is affected).</div>
        <div>• Escapes: can deal extra damage to your Base.</div>
        <div class="mono" style="margin-top:6px">Note: This system does not change time; it changes reward/damage multipliers.</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">Economy: Gold & Paladyum</div>
        <div>• <b>Gold</b>: used for in-run upgrades (damage, fire rate, range, etc.).</div>
        <div>• <b>Paladyum</b>: permanent meta currency (Meta Upgrades, modules, slot unlocks).</div>
        <div>• Paladyum is granted deterministically at wave end (affected by your performance and modules).</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">Upgrades</div>
        <div>In the Tower screen, you buy upgrades that shape your wave performance:</div>
        <div>• <b>Damage / Fire Rate</b>: increases DPS.</div>
        <div>• <b>Range</b>: lets you engage earlier.</div>
        <div>• <b>Base HP / Repair / Fortify</b>: improves survivability.</div>
        <div>• <b>Crit / MultiShot</b>: more explosive damage profile (deterministic crit).</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">Modules</div>
        <div>Modules are the core of build-making. Offense/Defense/Utility modules change how your tower behaves.</div>
        <div>• Modules are not random drops; you unlock them with Paladyum and upgrade their levels.</div>
        <div>• Slot count is limited; you unlock more slots as you progress.</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">What Does Deterministic (No RNG) Mean?</div>
        <div>With the same wave, the same upgrades, the same modules, and the same settings, the game produces the same outcomes.</div>
        <div>This makes balance and build experiments easier to read: decisions matter more than luck.</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">Tips</div>
        <div>• If you miss the KR target: stabilize DPS first (damage/fire rate), then add survivability.</div>
        <div>• If too many enemies escape: range + slow + baseHP/repair combos are strong.</div>
        <div>• For performance: Settings → <span class="mono">Reduce Effects</span>.</div>
      </div>
    `

    panel.append(header, body)
    return panel
  }

  function showHowToPlayModal() {
    const panel = buildHowToPlayPanel({
      backLabel: 'Close',
      onBack: () => overlay.remove(),
    })
    panel.style.width = 'min(920px, calc(100vw - 20px))'

    const overlay = mountModal(panel)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) overlay.remove()
    })
  }

  async function showDailyContractsModal() {
    if (!game || !lastState) return

    const nowUTC = Date.now()
    const info = getDailyContracts({ state: lastState, config, nowUTC })
    if (info.state !== lastState) {
      lastState = info.state
      game.setSnapshot(info.state, 'soft')
    }

    const modal = el('div', 'panel')
    modal.style.position = 'absolute'
    modal.style.left = '50%'
    modal.style.top = '10%'
    modal.style.transform = 'translateX(-50%)'
    modal.style.width = 'min(820px, calc(100vw - 24px))'
    modal.style.pointerEvents = 'auto'

    const h = el('div', 'panel-header')
    h.textContent = 'DAILY CONTRACTS'

    const b = el('div', 'panel-body')
    b.style.lineHeight = '1.45'

    const note = el('div', 'muted')
    note.textContent = 'Resets at 00:00 UTC. Deterministic, no RNG.'
    note.style.marginBottom = '10px'
    b.appendChild(note)

    let overlay: HTMLDivElement

    const renderContract = (c: DailyContractView) => {
      const card = el('div', 'panel')
      card.style.marginBottom = '10px'

      const ch = el('div', 'panel-header')
      ch.textContent = c.titleEN

      const cb = el('div', 'panel-body')

      const desc = el('div', 'muted')
      desc.textContent = c.descEN

      const prog = el('div', 'muted')
      prog.style.marginTop = '6px'
      prog.innerHTML = `Progress: <span class="mono">${formatNumber(c.progress, lastState!.settings.numberFormat)}</span> / <span class="mono">${formatNumber(c.goal, lastState!.settings.numberFormat)}</span>`

      const reward = el('div', 'muted')
      reward.style.marginTop = '6px'
      reward.innerHTML = `Reward: <span class="mono">${formatPaladyumInt(c.rewardPoints)}</span> Paladyum`

      const row = el('div', 'stack')
      row.style.marginTop = '10px'

      const claimBtn = btn(c.claimed ? 'Claimed' : c.completed ? 'Claim' : 'Incomplete', 'btn btn-primary')
      ;(claimBtn as HTMLButtonElement).disabled = c.claimed || !c.completed

      claimBtn.onclick = () => {
        void (async () => {
          const g = game
          if (!g || !lastState) return

          const elBtn = claimBtn as HTMLButtonElement
          if (elBtn.disabled) return

          elBtn.disabled = true
          const prevTxt = elBtn.textContent
          elBtn.textContent = 'Claiming…'

          try {
            const res = claimDailyContract({
              state: lastState,
              config,
              nowUTC: Date.now(),
              contractId: c.id,
            })
            if (!res.claimed) {
              elBtn.textContent = prevTxt
              elBtn.disabled = false
              flashFail(elBtn)
              return
            }

            lastState = res.state
            g.setSnapshot(res.state, 'soft')
            saveSnapshot(config, res.state)

            // Keep menu badge accurate even before the modal is closed.
            refreshContractsBadgeGlobal?.()

            // Menu Paladyum line is not reactive; force a re-render so it updates.
            render()

            // If signed in, upload immediately so contracts continue across devices.
            const st = firebaseSync?.getStatus()
            const canCloud = !!firebaseSync && !!st?.configured && !!st?.signedIn
            if (canCloud) {
              try {
                await withLoading(async () => {
                  await firebaseSync!.uploadMetaFromState(g.getSnapshot())
                })
              } catch (e) {
                alert(String((e as any)?.message ?? e))
              }
            }

            overlay.remove()
            await showDailyContractsModal()
          } finally {
            // If the modal is still open (e.g., claim failed), restore the button.
            if (document.body.contains(elBtn)) {
              if (!elBtn.disabled) elBtn.textContent = prevTxt
            }
          }
        })()
      }

      row.appendChild(claimBtn)
      cb.append(desc, prog, reward, row)
      card.append(ch, cb)
      return card
    }

    for (const c of info.contracts) b.appendChild(renderContract(c))

    const close = btn('Close', 'btn')
    close.onclick = () => {
      overlay.remove()
      render()
    }
    b.appendChild(close)

    modal.append(h, b)
    overlay = mountModal(modal)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) {
        overlay.remove()
        render()
      }
    })
  }

  function showWaveComplete(report: WaveReport) {
    const modal = el('div', 'panel')
    modal.style.position = 'absolute'
    modal.style.left = '50%'
    modal.style.top = '18%'
    modal.style.transform = 'translateX(-50%)'
    modal.style.width = 'min(680px, calc(100vw - 24px))'
    modal.style.pointerEvents = 'auto'

    const h = el('div', 'panel-header')
    h.textContent = 'WAVE COMPLETE'

    const b = el('div', 'panel-body')
    const warn = report.penaltyFactor < 1

    b.innerHTML = `
      <div class="muted">Killed: <span class="mono">${report.killed}</span> • Escaped: <span class="mono">${report.escaped}</span></div>
      <div class="muted">KR: <span class="mono">${report.killRatio.toFixed(2)}</span> • Target: <span class="mono">${report.threshold.toFixed(2)}</span></div>
      <div class="muted">Reward: <span class="mono">${formatNumber(report.rewardGold, lastState?.settings.numberFormat ?? 'suffix')}</span> gold • <span class="mono">${formatPaladyumInt(report.rewardPoints)}</span> Paladyum</div>
      <div class="muted" style="margin-top:6px; color:${warn ? 'var(--danger)' : 'var(--neon-lime)'}">Penalty Multiplier: <span class="mono">x${report.penaltyFactor.toFixed(2)}</span></div>
    `

    const c = btn('Continue', 'btn btn-primary')
    const overlay = mountModal(modal)
    const AUTO_CLOSE_SEC = 10
    const startedAt = performance.now()
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearInterval(tick)
      overlay.remove()
      game?.continueNextWave()
    }

    c.onclick = () => finish()

    const autoBox = el('div', 'muted')
    autoBox.style.marginTop = '10px'
    autoBox.style.fontSize = '12px'

    const autoLabel = el('div', 'mono')
    autoLabel.style.marginBottom = '6px'

    const barOuter = el('div')
    barOuter.style.height = '6px'
    barOuter.style.borderRadius = '999px'
    barOuter.style.background = 'var(--stroke)'
    barOuter.style.overflow = 'hidden'

    const barInner = el('div')
    barInner.style.height = '100%'
    barInner.style.width = '0%'
    barInner.style.background = 'var(--neon-lime)'
    barOuter.appendChild(barInner)

    autoBox.append(autoLabel, barOuter)

    const tick = window.setInterval(() => {
      if (done) return
      const elapsed = (performance.now() - startedAt) / 1000
      const left = Math.max(0, AUTO_CLOSE_SEC - elapsed)
      const progress = Math.max(0, Math.min(1, elapsed / AUTO_CLOSE_SEC))
      autoLabel.textContent = `Auto-continue in ${left.toFixed(1)}s`
      barInner.style.width = `${(progress * 100).toFixed(2)}%`
      if (left <= 0) finish()
    }, 100)

    const row = el('div', 'stack')
    row.style.marginTop = '10px'
    row.appendChild(c)
    b.append(row, autoBox)

    modal.append(h, b)
  }

  function showOffline(result: OfflineProgressResult) {
    setScreen('offline')

    const modal = el('div', 'panel')
    modal.style.position = 'absolute'
    modal.style.left = '50%'
    modal.style.top = '14%'
    modal.style.transform = 'translateX(-50%)'
    modal.style.width = 'min(720px, calc(100vw - 24px))'
    modal.style.pointerEvents = 'auto'

    const h = el('div', 'panel-header')
    h.textContent = 'WHILE YOU WERE OFFLINE'

    const b = el('div', 'panel-body')

    b.innerHTML = `
      <div class="muted">Time: <span class="mono">${formatTimeMMSS(result.elapsedSec)}</span></div>
      <div class="muted">Estimated waves: <span class="mono">${result.offlineWaves}</span></div>
      <div class="muted">Gains: <span class="mono">${formatNumber(result.gainedGold, lastState?.settings.numberFormat ?? 'suffix')}</span> (x${result.factorApplied.toFixed(2)})</div>
      <div class="muted" style="margin-top:6px">Note: ${result.estimatedKillRatioNoteTR}</div>
    `

    const overlay = mountModal(modal)

    const collect = btn('Collect', 'btn btn-primary')

    collect.onclick = async () => {
      const g = game
      if (!g) return
      collect.disabled = true
      try {
        await withLoading(async () => {
          g.setSnapshot(result.stateAfter)
          lastState = g.getSnapshot()

          // Offline collection should never start gameplay automatically.
          g.setPaused(true)

          // If signed in, upload meta so offline Paladyum is synced.
          const st = firebaseSync?.getStatus()
          if (firebaseSync && st?.configured && st.signedIn) {
            await firebaseSync.uploadMetaFromState(g.getSnapshot())
          }
        })

        overlay.remove()
        setScreen('menu')
      } catch (e) {
        alert(String((e as any)?.message ?? e))
      } finally {
        collect.disabled = false
      }
    }

    const row = el('div', 'stack')
    row.style.marginTop = '10px'
    row.append(collect)
    b.appendChild(row)

    modal.append(h, b)
  }

  function showGameOver(summary: RunSummary) {
    const modal = el('div', 'panel')
    modal.style.position = 'absolute'
    modal.style.left = '50%'
    modal.style.top = '18%'
    modal.style.transform = 'translateX(-50%)'
    modal.style.width = 'min(640px, calc(100vw - 24px))'
    modal.style.pointerEvents = 'auto'

    const h = el('div', 'panel-header')
    h.textContent = 'RUN ENDS'

    const b = el('div', 'panel-body')
    b.innerHTML = `
      <div class="muted">Ended at wave: <span class="mono">${summary.endedAtWave}</span></div>
      <div class="muted">Total gold: <span class="mono">${formatNumber(summary.totalGoldThisRun, lastState?.settings.numberFormat ?? 'suffix')}</span></div>
      <div class="muted">Time: <span class="mono">${formatTimeMMSS(summary.totalTimeSec)}</span></div>
    `

    const overlay = mountModal(modal)

    const row = el('div', 'stack')
    row.style.marginTop = '10px'

    const menu = btn('Menu', 'btn btn-primary')
    menu.onclick = () => {
      void (async () => {
        if (!game) {
          overlay.remove()
          setScreen('menu')
          return
        }

        // Capture latest snapshot and persist before leaving.
        game.setPaused(true)
        const snapshot = game.getSnapshot()
        lastState = snapshot

        const st = firebaseSync?.getStatus()
        const canCloud = !!firebaseSync && !!st?.configured && !!st?.signedIn

        // Prevent double-clicks while saving.
        menu.disabled = true
        try {
          if (canCloud) {
            await withLoading(async () => {
              saveSnapshot(config, snapshot)
              await firebaseSync!.uploadMetaFromState(snapshot)
            })
          } else {
            saveSnapshot(config, snapshot)
          }
        } catch (e) {
          // Keep local progress and still go to menu.
          alert(String((e as any)?.message ?? e))
        } finally {
          menu.disabled = false
        }

        overlay.remove()
        setScreen('menu')
      })()
    }

    row.append(menu)
    b.appendChild(row)

    modal.append(h, b)
  }

  function bindGame(g: NeonGridGame) {
    game = g
    let scheduled = false
    game.onSim((pub) => {
      lastSim = pub
      lastState = pub.state

      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        if (screen === 'hud' || screen === 'modules' || screen === 'settings' || screen === 'stats') {
          render()
        }
      })
    })

    // Initial render once state is available.
    lastState = g.getSnapshot()
    lastSim = null

    if (resetRequested) {
      resetRequested = false
      setFreshLocalSnapshot(true)
    }
    render()

    // If a user is already signed in (persisted auth), perform one-time cloud sync.
    void maybeInitialCloudSync()

    // Boot into menu if needed.
    if (screen === 'boot') render()
  }

  function setHUDState(s: GameState) {
    lastState = s
  }

  return {
    bindGame,
    setHUDState,
    setScreen,
    showWaveComplete,
    showOffline,
    showGameOver,
  }
}
