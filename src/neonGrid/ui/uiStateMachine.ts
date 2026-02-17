import type { GameConfig, GameState, OfflineProgressResult, RunSummary, TowerUpgradeKey, WaveReport } from '../types'
import type { NeonGridGame } from '../phaser/createGame'
import type { SimPublic } from '../sim/SimEngine'
import { createNewState } from '../persistence/save'
import { btn, clear, el, hr, kv } from './dom'
import { formatNumber, formatPaladyumInt, formatPct, formatTimeHhMmSs, formatTimeMMSS } from './format'
import {
  baseDmg,
  calcPenaltyFactor,
  calcWaveSnapshot,
  clamp,
  critAverageDamageMult,
  effectiveCritParams,
  fireRate,
  towerArmorPierceBonus,
  towerEscapeDamageMult,
  towerGoldMult,
  towerMultiShotCount,
  towerRange,
  towerRepairPctPerSec,
  towerEnemySpeedMult,
} from '../sim/deterministic'
import {
  finalizeResearchIfComplete,
  labEffectMult,
  labEffectMultForKey,
  labLevel,
  researchCostPointsForNext,
  researchDurationSecForNext,
  sanitizeLabState,
} from '../labs/labs'
import { calcBaseHPMax } from '../sim/actions'
import { metaUpgradeCostPoints, skillsRespecCostPoints, upgradeCost, upgradeMaxLevel } from '../sim/costs'
import {
  SKILLS,
  TIER1_MAX_UNLOCKS_PER_BRANCH,
  aggregateSkillPassives,
  branchSpentCount,
  branchTier1UnlockedCount,
  tierRequirementCount,
  xpToNext,
  type SkillBranch,
  type SkillId,
} from '../skills/skills'
import { SKILL_CARDS } from '../skills/skillCards.ts'

export type UIScreen = 'boot' | 'menu' | 'hud' | 'settings' | 'stats' | 'offline'

type UIArgs = {
  root: HTMLElement
  config: GameConfig
  initialState: UIScreen
  offlineResult: OfflineProgressResult
}

export function createUIStateMachine(args: UIArgs) {
  const { root, config } = args
  let resetRequested = false

  let upgradesTab: 'attack' | 'defense' | 'utility' = 'attack'
  let skillsTab: SkillBranch = 'attack'

  let toastIdSeq = 1
  const activeToasts: Array<{ id: number; msg: string; kind: 'good' | 'warn' }> = []
  const toastLayer = el('div', 'ng-toasts')

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

  // (Intentionally no debug/test logging in production UI.)

  const layer = el('div', 'ui-layer')
  root.appendChild(layer)

  let game: NeonGridGame | null = null
  let lastState: GameState | null = null
  let lastSim: SimPublic | null = null

  let screen: UIScreen = args.initialState

  const top = el('div', 'hud-top')
  const center = el('div', 'ui-center')
  const bottom = el('div')

  layer.append(top, center, bottom)
  layer.appendChild(toastLayer)

  function renderToasts() {
    clear(toastLayer)
    if (activeToasts.length === 0) return
    for (const t of activeToasts) {
      const item = el('div', 'ng-toast ' + (t.kind === 'warn' ? 'warn' : 'good'))
      item.textContent = t.msg
      toastLayer.appendChild(item)
    }
  }

  function pushToast(msg: string, kind: 'good' | 'warn' = 'good') {
    const id = toastIdSeq++
    activeToasts.push({ id, msg, kind })
    renderToasts()
    window.setTimeout(() => {
      const idx = activeToasts.findIndex((t) => t.id === id)
      if (idx >= 0) activeToasts.splice(idx, 1)
      renderToasts()
    }, 2400)
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
    const skills = aggregateSkillPassives(state)

    const lab = sanitizeLabState((state as any).lab)
    const dmgLabMult = labEffectMultForKey(lab, 'damage')
    const frLabMult = labEffectMultForKey(lab, 'fireRate')
    const rangeLabMult = labEffectMultForKey(lab, 'range')

    // Modules feature removed/disabled: keep formulas deterministic without module modifiers.
    const noMods = { critEveryN: Number.POSITIVE_INFINITY, critMult: 1 } as any

    const baseDamage = baseDmg(state.towerUpgrades.damageLevel, config, dmgLabMult)
    const damagePerShot = Math.max(0, baseDamage * skills.dmgMult)
    const crit = effectiveCritParams(state, config, noMods)
    const critAvg = critAverageDamageMult(state, config, noMods)

    const fireRateBase = fireRate(state.towerUpgrades.fireRateLevel, config, frLabMult)
    const fireRateFinal = Math.max(0.1, fireRateBase * (1 + skills.fireRateBonus))

    const rangeBase = towerRange(state.towerUpgrades.rangeLevel, config, rangeLabMult)
    const rangeFinal = Math.max(0, rangeBase)

    const armorPierceBonus = towerArmorPierceBonus(state, config)
    const armorPierceFinal = clamp(config.tower.armorPierce0 + armorPierceBonus + skills.armorPierceBonus, 0, 0.9)

    const baseTargets = towerMultiShotCount(state, config)
    const targetsFinal = Math.max(1, Math.floor(baseTargets))

    const maxHP = Math.max(1, calcBaseHPMax(state, config))
    const repairPct = towerRepairPctPerSec(state, config)

    const slowBaseMult = towerEnemySpeedMult(state, config)
    const slowFinalMult = slowBaseMult

    const escapeDamageMult = towerEscapeDamageMult(state, config)

    const goldMultFinal = Math.max(0, towerGoldMult(state, config))

    const dps = Math.max(0, damagePerShot * fireRateFinal * critAvg)

    return {
      skills,
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
    }
  }

  function setScreen(next: UIScreen) {
    screen = next
    if (game && (next === 'menu' || next === 'boot' || next === 'offline')) {
      game.setPaused(true)
    }
    if (game && next === 'hud') {
      // Ensure HUD reflects the latest snapshot immediately.
      lastState = game.getSnapshot()
    }
    render()
  }

  function render() {
    cleanupStaleModalOverlays()

    // Hard guarantee: home-related screens never run gameplay.
    if (game && (screen === 'menu' || screen === 'boot' || screen === 'offline')) {
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

    // In-game / overlays
    renderHUD(screen !== 'hud')

    if (screen === 'settings') renderSettings()
    if (screen === 'stats') renderStats()

    renderToasts()
  }

  function renderBoot() {
    const wrap = el('div', 'ng-menu-layout')

    const panel = el('div', 'panel ng-menu')
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    const title = el('div', 'ng-menu-title')
    title.textContent = 'NEON GRID'
    header.appendChild(title)

    const badge = el('div', 'muted mono')
    badge.style.fontSize = '10px'
    badge.textContent = 'NO RNG'
    header.appendChild(badge)

    const body = el('div', 'panel-body')
    const p = el('div', 'muted')
    p.textContent = 'Initializing deterministic simulation…'
    p.style.marginBottom = '12px'

    const bar = el('div', 'bar')
    bar.style.height = '4px'
    const fill = el('div', 'fill')
    fill.style.width = '0%'
    bar.appendChild(fill)

    const tip = el('div', 'muted')
    tip.style.marginTop = '12px'
    tip.style.fontSize = '11px'

    const tips = config.ui.tipsTR
    const dayIndex = Math.floor(Date.now() / 86400_000)
    tip.textContent = `Tip: ${tips[dayIndex % tips.length]}`

    body.append(p, bar, tip)
    panel.append(header, body)
    wrap.appendChild(panel)
    center.appendChild(wrap)

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

  function renderResourcesBar(stateLike: any) {
    const bar = el('div', 'ng-resources-bar')
    const lvl = Math.max(0, Math.floor(stateLike?.skills?.level ?? 0))
    const xp = Math.max(0, Math.floor(stateLike?.skills?.xp ?? 0))
    const sp = Math.max(0, Math.floor(stateLike?.skills?.skillPoints ?? 0))
    const nextXP = xpToNext(lvl)
    const pal = formatPaladyumInt(Math.max(0, Math.floor(Number(stateLike?.points ?? 0))))
    bar.append(
      kv('Level', String(lvl), true, 'kv-cyan'),
      kv('XP', `${xp}/${nextXP}`, true, 'kv-cyan'),
      kv('Skill Pts', String(sp), true, sp > 0 ? 'kv-magenta' : undefined),
      kv('Palladium', pal, true, 'kv-lime'),
    )
    return bar
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

    const infoRow = el('div')
    infoRow.style.marginBottom = '14px'
    infoRow.appendChild(renderResourcesBar(lastState as any))
    const note = el('div', 'muted')
    note.style.fontSize = '11px'
    note.style.marginTop = '6px'
    note.textContent = 'Deterministic • No RNG'
    infoRow.appendChild(note)

    const row = el('div', 'ng-menu-actions')
    row.style.marginTop = '0'

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

    const iconSkills = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 3v18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M12 7c-4 0-7 2-8 5 1 3 4 5 8 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 7c4 0 7 2 8 5-1 3-4 5-8 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>
      </svg>
    `

    const iconLab = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M10 3v6l-4.5 8.2A3 3 0 0 0 8.1 21h7.8a3 3 0 0 0 2.6-3.8L14 9V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M9 13h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
      </svg>
    `

    const iconInfo = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" stroke="currentColor" stroke-width="2"/>
        <path d="M12 10.5V17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M12 7.5h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
      </svg>
    `


    const newRun = menuBtn('New Run', iconPlay, 'lime')
    newRun.onclick = () => {
      if (!game) return
      game.newRun()
      setScreen('hud')
    }

    const skills = menuBtn('Skills', iconSkills, 'magenta')
    {
      const sp = Math.max(0, Math.floor((lastState as any)?.skills?.skillPoints ?? 0))
      if (sp > 0) {
        const badge = el('span', 'ng-menu-badge')
        badge.textContent = sp >= 100 ? '99+' : String(sp)
        skills.appendChild(badge)
      }
    }
    skills.onclick = () => {
      void (async () => {
        if (game) game.setPaused(true)
        await showSkillsModal()
      })()
    }

    const skillCardsBtn = menuBtn('Skill Cards', iconSkills, 'cyan')
    skillCardsBtn.onclick = () => {
      void (async () => {
        if (game) game.setPaused(true)
        await showSkillCardsModal()
      })()
    }

    const labBtn = menuBtn('Lab', iconLab, 'lime')
    labBtn.onclick = () => {
      void (async () => {
        if (game) game.setPaused(true)
        await showLabsModal()
      })()
    }

    const stats = menuBtn('Stats', iconChart, 'cyan')
    stats.onclick = () => {
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
      if (game) game.setPaused(true)
      showTowerModal()
    }

    const metaUpg = menuBtn('Meta Upgrades', iconHex, 'lime')
    metaUpg.onclick = () => {
      if (!lastState) return
      void showMetaUpgradesModal()
    }

    row.append(newRun, metaUpg, skills, skillCardsBtn, labBtn, tower, stats, settings, how)

    body.append(infoRow, row)

    panel.append(header, body)
    layout.appendChild(panel)
    center.appendChild(layout)
  }

  async function showMetaUpgradesModal() {
    if (!lastState || !game) return

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
      render()
    }
    h.append(title, close)

    const b = el('div', 'panel-body ng-meta-body')

    const bal = renderResourcesBar(lastState as any)
    bal.classList.add('ng-meta-balance')

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
          buyOk = Boolean((g as any).buyMetaUpgrade?.(key, amt))
          if (!buyOk) return

          // No persistence by design.
          lastState = g.getSnapshot()
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

  function renderSkillsTabs(onChange: (b: SkillBranch) => void) {
    const row = el('div', 'stack')
    const mk = (label: string, key: SkillBranch) => {
      const b = btn(label, 'btn')
      b.classList.toggle('is-selected', skillsTab === key)
      b.onclick = () => {
        skillsTab = key
        onChange(key)
      }
      return b
    }
    row.append(mk('Attack', 'attack'), mk('Defense', 'defense'), mk('Utility', 'utility'))
    return row
  }

  async function showLabsModal() {
    if (!lastState || !game) return
    const g = game

    // Finalize completed research on open.
    g.finalizeLabs()
    const state = g.getSnapshot()
    lastState = state

    const modal = el('div', 'panel')
    modal.style.width = 'min(760px, calc(100vw - 20px))'
    modal.style.pointerEvents = 'auto'

    const overlay = mountModal(modal)
    let closed = false
    let tickId: number | null = null
    const cleanup = () => {
      if (closed) return
      closed = true
      if (tickId !== null) {
        window.clearInterval(tickId)
        tickId = null
      }
    }

    const h = el('div', 'panel-header')
    const title = el('div')
    title.textContent = 'Lab'
    const close = btn('Close', 'btn')
    close.onclick = () => {
      cleanup()
      overlay.remove()
      render()
    }
    h.append(title, close)

    const b = el('div', 'panel-body')

    const nowUTC = Date.now()
    const lab = finalizeResearchIfComplete(sanitizeLabState((state as any).lab), nowUTC)
    const active = lab?.research ?? null

    const bal = renderResourcesBar(state as any)
    bal.style.marginBottom = '10px'
    b.appendChild(bal)

    const labPanel = el('div', 'ng-lab-panel')
    const labHead = el('div', 'ng-lab-head')
    labHead.innerHTML = `<div style="font-weight:900; letter-spacing:0.03em">Research</div><div class="muted" style="font-size:11px">Real-time research • Costs Palladium</div>`

    const labelForKey: Record<TowerUpgradeKey, string> = {
      damage: 'Damage',
      fireRate: 'Fire Rate',
      crit: 'Crit',
      multiShot: 'Multi Shot',
      armorPierce: 'Armor Pierce',
      baseHP: 'Base HP',
      slow: 'Slow',
      fortify: 'Fortify',
      repair: 'Repair',
      range: 'Range',
      gold: 'Gold',
    }

    const fmtCoef = (v: number): string => {
      const a = Math.abs(v)
      if (!Number.isFinite(v)) return '0'
      if (a === 0) return '0'
      if (a < 0.001) return v.toExponential(2)
      if (a < 0.1) return v.toFixed(4)
      return v.toFixed(3)
    }

    const coefHtml = (key: TowerUpgradeKey, multNow: number, multNext: number): string => {
      const m0 = Math.max(0, multNow)
      const m1 = Math.max(0, multNext)
      switch (key) {
        case 'damage': {
          const base = config.progression.dmgGrowthD
          return `Growth: <span class="mono">${fmtCoef(base * m0)}</span> → <span class="mono">${fmtCoef(base * m1)}</span>`
        }
        case 'fireRate': {
          const base = config.progression.fireRateLogK
          return `k: <span class="mono">${fmtCoef(base * m0)}</span> → <span class="mono">${fmtCoef(base * m1)}</span>`
        }
        case 'range': {
          const base = config.tower.rangeGrowth
          return `Per Lv: <span class="mono">${fmtCoef(base * m0)}</span> → <span class="mono">${fmtCoef(base * m1)}</span>`
        }
        case 'baseHP': {
          const base = config.tower.baseHPGrowth
          return `Growth: <span class="mono">${fmtCoef(base * m0)}</span> → <span class="mono">${fmtCoef(base * m1)}</span>`
        }
        case 'armorPierce': {
          const base = config.tower.upgrades.armorPiercePerLevel
          return `Per Lv: <span class="mono">${fmtCoef(base * m0)}</span> → <span class="mono">${fmtCoef(base * m1)}</span>`
        }
        case 'slow': {
          const base = config.tower.upgrades.slowPerLevel
          return `Per Lv: <span class="mono">${fmtCoef(base * m0)}</span> → <span class="mono">${fmtCoef(base * m1)}</span>`
        }
        case 'fortify': {
          const base = config.tower.upgrades.fortifyPerLevel
          return `Per Lv: <span class="mono">${fmtCoef(base * m0)}</span> → <span class="mono">${fmtCoef(base * m1)}</span>`
        }
        case 'repair': {
          const base = config.tower.upgrades.repairPctPerSecPerLevel
          return `Per Lv: <span class="mono">${fmtCoef(base * m0)}</span> → <span class="mono">${fmtCoef(base * m1)}</span>`
        }
        case 'gold': {
          const base = config.tower.upgrades.goldMultPerLevel
          return `Per Lv: <span class="mono">${fmtCoef(base * m0)}</span> → <span class="mono">${fmtCoef(base * m1)}</span>`
        }
        case 'crit': {
          const baseReduce = config.tower.upgrades.critEveryNReducePerLevel
          const baseMult = config.tower.upgrades.critMultPerLevel
          return `Reduce: <span class="mono">${fmtCoef(baseReduce * m0)}</span> → <span class="mono">${fmtCoef(baseReduce * m1)}</span> • Mult: <span class="mono">${fmtCoef(baseMult * m0)}</span> → <span class="mono">${fmtCoef(baseMult * m1)}</span>`
        }
        case 'multiShot': {
          return `Level mult: <span class="mono">x${m0.toFixed(2)}</span> → <span class="mono">x${m1.toFixed(2)}</span>`
        }
      }
    }

    const groups: Array<{ title: string; keys: TowerUpgradeKey[] }> = [
      { title: 'Attack', keys: ['damage', 'fireRate', 'crit', 'multiShot', 'armorPierce'] },
      { title: 'Defense', keys: ['baseHP', 'slow', 'fortify', 'repair'] },
      { title: 'Utility', keys: ['range', 'gold'] },
    ]

    const makeCard = (key: TowerUpgradeKey) => {
      const card = el('div', 'ng-lab-card')

      const level = labLevel(lab, key)
      const multNow = labEffectMultForKey(lab, key)
      const multNext = labEffectMult(level + 1)

      const hh = el('div', 'ng-lab-card-head')
      hh.textContent = `${labelForKey[key]} • Lv ${level}`

      const coef = el('div', 'muted')
      coef.style.fontSize = '11px'
      coef.innerHTML = coefHtml(key, multNow, multNext)

      const actions = el('div', 'ng-lab-actions')

      const isActive = active && active.key === key
      const busyOther = !!active && active.key !== key

      if (isActive) {
        const line = el('div', 'muted')
        line.style.fontSize = '11px'
        const remainingSpan = el('span', 'mono')
        const renderRemaining = () => {
          const rSec = Math.max(0, Math.floor(((active?.endsAtUTC ?? 0) - Date.now()) / 1000))
          remainingSpan.textContent = formatTimeHhMmSs(rSec)
        }
        line.append(
          document.createTextNode('Research in progress • Remaining: '),
          remainingSpan,
        )

        // Live countdown while modal is open.
        renderRemaining()
        if (tickId === null) {
          tickId = window.setInterval(() => {
            if (closed) return
            if (!active) return
            if (Date.now() >= active.endsAtUTC) {
              // Finalize + refresh modal so levels update instantly.
              g.finalizeLabs()
              cleanup()
              overlay.remove()
              void showLabsModal()
              return
            }
            renderRemaining()
          }, 1000)
        }

        actions.append(line)
      } else {
        const costPoints = researchCostPointsForNext(lab, key)
        const durSec = researchDurationSecForNext(lab, key)

        const line = el('div', 'muted')
        line.style.fontSize = '11px'
        line.innerHTML = `Next: <span class="mono">${formatTimeHhMmSs(durSec)}</span> • Cost: <span class="mono">${formatPaladyumInt(costPoints)}</span> Palladium`

        const startBtn = btn('Start Research', 'btn btn-primary')
        startBtn.disabled = busyOther
        startBtn.onclick = () => {
          const r = g.startLabResearch(key)
          if (!r.ok) {
            pushToast(r.reason ?? 'Cannot start research.', 'warn')
            return
          }
          pushToast(`${labelForKey[key]} Lab: research started`, 'good')
          overlay.remove()
          void showLabsModal()
        }

        actions.append(line, startBtn)

        if (busyOther) {
          const busy = el('div', 'muted')
          busy.style.fontSize = '11px'
          busy.style.marginTop = '6px'
          busy.textContent = `Busy: ${active.key} research in progress.`
          actions.appendChild(busy)
        }
      }

      card.append(hh, coef, actions)
      return card
    }

    for (const gDef of groups) {
      const head = el('div')
      head.style.marginTop = '10px'
      head.style.marginBottom = '6px'
      head.style.fontWeight = '900'
      head.style.letterSpacing = '0.02em'
      head.textContent = gDef.title
      b.appendChild(head)

      const sectionGrid = el('div', 'ng-lab-grid')
      for (const key of gDef.keys) sectionGrid.appendChild(makeCard(key))
      b.appendChild(sectionGrid)
    }

    // (Cards are now rendered in grouped sections for readability.)
    labPanel.append(labHead)
    b.appendChild(labPanel)

    modal.append(h, b)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) {
        cleanup()
        overlay.remove()
      }
    })
  }

  async function showSkillsModal() {
    if (!lastState || !game) return
    const g = game
    // Finalize completed Lab research (uses absolute UTC timestamps).
    g.finalizeLabs()
    const state = g.getSnapshot()
    lastState = state

    const modal = el('div', 'panel ng-skills-modal')
    modal.style.width = 'min(920px, calc(100vw - 20px))'
    modal.style.pointerEvents = 'auto'

    const overlay = mountModal(modal)

    const h = el('div', 'panel-header')
    const title = el('div')
    title.textContent = 'Skills'
    const close = btn('Close', 'btn')
    close.onclick = () => {
      overlay.remove()
      render()
    }
    h.append(title, close)

    const b = el('div', 'panel-body')
    const topRow = el('div', 'ng-skills-top')

    const sp = Math.max(0, Math.floor(state.skills?.skillPoints ?? 0))

    const bal = renderResourcesBar(state as any)

    const tabs = renderSkillsTabs(() => {
      overlay.remove()
      void showSkillsModal()
    })
    tabs.classList.add('ng-skills-tabs')

    const respecCostNow = skillsRespecCostPoints(Math.max(0, Math.floor(state.skills?.respecCount ?? 0)))
    const respecBtn = btn(`Respec (${formatPaladyumInt(respecCostNow)})`, 'btn')
    respecBtn.onclick = () => {
      const nextCost = skillsRespecCostPoints(Math.max(0, Math.floor(state.skills?.respecCount ?? 0)))
      const ok = window.confirm(`Reset all skills for Palladium?\nCost: ${formatPaladyumInt(nextCost)} (increases each time).`)
      if (!ok) return
      const r = g.respecSkills()
      if (!r.ok) {
        pushToast(`Not enough Palladium. Respec cost: ${formatPaladyumInt(r.cost)}`, 'warn')
        return
      }
      pushToast(`Skills reset (cost: ${formatPaladyumInt(r.cost)})`, 'good')
      overlay.remove()
      void showSkillsModal()
    }

    topRow.append(bal, tabs, respecBtn)
    b.appendChild(topRow)

    const branch = skillsTab
    const spentInBranch = branchSpentCount(state, branch)
    const tier1Unlocked = branchTier1UnlockedCount(state, branch)
    const skillsById = new Map<string, (typeof SKILLS)[number]>()
    for (const s of SKILLS) skillsById.set(s.id, s)
    const info = el('div', 'muted')
    info.style.marginTop = '8px'
    info.textContent = `Branch progress: ${spentInBranch} skills • Tier unlocks at 2 / 4 / 6 skills in the same branch • Tier 1 cap: ${tier1Unlocked}/${TIER1_MAX_UNLOCKS_PER_BRANCH}.`
    b.appendChild(info)

    // Skill tree: render as a clean list (no card tiles).
    const listWrap = el('div', 'ng-skill-list')
    const branchSkills = SKILLS.filter((s) => s.branch === branch)
    const tiers: Array<1 | 2 | 3 | 4> = [1, 2, 3, 4]
    for (const tier of tiers) {
      const tierBlock = el('div', 'ng-skill-list-tier')

      const sh = el('div', 'ng-skill-list-tier-header')
      const need = tierRequirementCount(tier)
      const unlocked = spentInBranch >= need
      sh.innerHTML = `Tier ${tier} <span class="muted" style="font-weight:600">${tier === 1 ? '(Start)' : unlocked ? '(Unlocked)' : `(Locked: ${need} skills required)`}</span>`
      tierBlock.appendChild(sh)

      const tierList = el('div', 'ng-skill-list-rows')
      const list = branchSkills.filter((s) => s.tier === tier)
      for (const def of list) {
        const rankRaw = state.skills?.nodes?.[def.id]
        const rank = typeof rankRaw === 'number' && Number.isFinite(rankRaw) ? Math.max(0, Math.floor(rankRaw)) : 0
        const isMax = rank >= def.maxRank

        const needTier = tierRequirementCount(def.tier)
        const tierOk = spentInBranch >= needTier
        const canSpend = sp > 0
        const requires = (def as any).requires as undefined | Array<{ id: string; rank?: number }>
        const unmet = (requires ?? []).filter((r) => {
          const need = Math.max(1, Math.floor(r.rank ?? 1))
          const haveRaw = state.skills?.nodes?.[r.id as any]
          const have = typeof haveRaw === 'number' && Number.isFinite(haveRaw) ? Math.max(0, Math.floor(haveRaw)) : 0
          return have < need
        })
        const prereqOk = unmet.length === 0
        const t1CapOk = def.tier !== 1 || rank > 0 || tier1Unlocked < TIER1_MAX_UNLOCKS_PER_BRANCH
        const locked = !tierOk || !prereqOk || !t1CapOk

        const row = el('div', 'ng-skill-row' + (rank > 0 ? ' active' : '') + (locked ? ' locked' : '') + (isMax ? ' maxed' : ''))
        const left = el('div', 'ng-skill-row-left')
        const ic = el('div', 'ng-skill-icon')
        ic.innerHTML = def.icon
        left.appendChild(ic)

        const mid = el('div', 'ng-skill-row-mid')
        const nameLine = el('div', 'ng-skill-row-name')
        nameLine.textContent = def.name
        const desc = el('div', 'muted ng-skill-row-desc')
        desc.textContent = def.description

        if (!t1CapOk) {
          const capLine = el('div', 'muted')
          capLine.textContent = `Tier 1 cap reached for this branch (${TIER1_MAX_UNLOCKS_PER_BRANCH}).`
          desc.appendChild(capLine)
        }

        if (!prereqOk) {
          const reqLine = el('div', 'muted')
          const parts = unmet.map((r) => {
            const need = Math.max(1, Math.floor(r.rank ?? 1))
            const nm = skillsById.get(r.id)?.name ?? r.id
            return `${nm}${need > 1 ? ` (Rank ${need})` : ''}`
          })
          reqLine.textContent = `Requires: ${parts.join(', ')}`
          desc.appendChild(reqLine)
        }

        mid.append(nameLine, desc)

        const right = el('div', 'ng-skill-row-right')
        const rankLine = el('div', 'ng-skill-row-rank')
        const pips = Array.from({ length: def.maxRank }, (_, i) => (i < rank ? '●' : '○')).join('')
        rankLine.innerHTML = `<span class="mono">${pips}</span>`

        const buy = btn(isMax ? 'Max' : rank > 0 ? 'Rank Up (1 SP)' : 'Unlock (1 SP)', 'btn btn-primary')
        buy.disabled = locked || isMax || !canSpend
        buy.onclick = () => {
          const r = g.buySkill(def.id as SkillId)
          if (!r.ok) {
            pushToast(r.reason ?? 'Cannot buy skill.', 'warn')
            return
          }
          pushToast(`Skill Unlocked: ${def.name}`, 'good')
          overlay.remove()
          void showSkillsModal()
        }

        if (locked) {
          const lock = el('div', 'ng-skill-row-lock')
          lock.textContent = '🔒'
          right.append(lock)
        }

        right.append(rankLine, buy)
        row.append(left, mid, right)
        tierList.appendChild(row)
      }

      tierBlock.appendChild(tierList)
      listWrap.appendChild(tierBlock)
    }

    b.appendChild(listWrap)
    modal.append(h, b)

    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) overlay.remove()
    })
  }

  async function showSkillCardsModal() {
    if (!lastState || !game) return
    const g = game
    // Finalize completed Lab research (uses absolute UTC timestamps).
    g.finalizeLabs()
    const state = g.getSnapshot()
    lastState = state

    const modal = el('div', 'panel ng-skillcards-modal')
    modal.style.width = 'min(920px, calc(100vw - 20px))'
    modal.style.pointerEvents = 'auto'

    const overlay = mountModal(modal)

    const h = el('div', 'panel-header')
    const title = el('div')
    title.textContent = 'Skill Cards'
    const close = btn('Close', 'btn')
    close.onclick = () => {
      overlay.remove()
      render()
    }
    h.append(title, close)

    const b = el('div', 'panel-body')
    b.style.display = 'grid'
    b.style.gridTemplateColumns = '1fr'
    b.style.gap = '10px'

    const topRow = el('div', 'ng-skills-top')
    const bal = renderResourcesBar(state as any)
    const hint = el('div', 'muted')
    hint.style.fontSize = '12px'
    hint.style.maxWidth = '520px'
    hint.textContent = 'Equip up to 3 cards. No cost to equip/unequip.'
    topRow.append(bal, hint)
    b.appendChild(topRow)

    const eq = (state as any).skillCardsEquipped as Record<number, string | null> | undefined
    const equipped: Record<1 | 2 | 3, string | null> = {
      1: (eq && typeof eq === 'object' ? eq[1] : null) ?? null,
      2: (eq && typeof eq === 'object' ? eq[2] : null) ?? null,
      3: (eq && typeof eq === 'object' ? eq[3] : null) ?? null,
    }

    const equippedSlotOf = (id: string): number | null => {
      for (const s of [1, 2, 3] as const) if (equipped[s] === id) return s
      return null
    }

    const firstEmptySlot = (): 1 | 2 | 3 | null => {
      for (const s of [1, 2, 3] as const) if (!equipped[s]) return s
      return null
    }

    const slotsRow = el('div')
    slotsRow.style.display = 'grid'
    slotsRow.style.gridTemplateColumns = 'repeat(3, 1fr)'
    slotsRow.style.gap = '10px'

    for (const s of [1, 2, 3] as const) {
      const box = el('div', 'panel')
      const hh = el('div', 'panel-header')
      hh.textContent = `Slot ${s}`
      const bb = el('div', 'panel-body')

      const id = equipped[s]
      if (!id) {
        const t = el('div', 'muted mono')
        t.textContent = 'Empty'
        bb.appendChild(t)
      } else {
        const def = SKILL_CARDS.find((c) => c.id === id)
        const nm = def ? `${def.icon} ${def.name}` : id
        const title = el('div', 'mono')
        title.style.fontWeight = '900'
        title.textContent = nm
        const desc = el('div', 'muted')
        desc.style.fontSize = '12px'
        desc.textContent = def?.description ?? ''
        const rm = btn('Remove', 'btn btn-danger')
        rm.style.marginTop = '8px'
        rm.onclick = () => {
          const ok = g.equipSkillCard(s, null)
          if (!ok) return
          overlay.remove()
          void showSkillCardsModal()
        }
        bb.append(title, desc, rm)
      }

      box.append(hh, bb)
      slotsRow.appendChild(box)
    }

    const listTitle = el('div', 'muted')
    listTitle.style.fontWeight = '900'
    listTitle.textContent = 'Cards'

    const list = el('div')
    list.style.display = 'grid'
    list.style.gridTemplateColumns = 'repeat(auto-fit, minmax(220px, 1fr))'
    list.style.gap = '10px'

    for (const c of SKILL_CARDS) {
      const card = el('div', 'panel')
      const ch = el('div', 'panel-header')
      const left = el('div')
      left.textContent = `${c.icon} ${c.name}`
      const right = el('div', 'muted mono')
      right.textContent = c.tone.toUpperCase()
      ch.append(left, right)

      const cb = el('div', 'panel-body')
      const desc = el('div', 'muted')
      desc.style.fontSize = '12px'
      desc.textContent = c.description

      const actions = el('div', 'stack')
      actions.style.marginTop = '8px'

      const slot = equippedSlotOf(c.id)
      if (slot) {
        const b = btn('Equipped', 'btn')
        b.disabled = true
        actions.appendChild(b)
      } else {
        const b = btn('Equip', 'btn btn-primary')
        b.onclick = () => {
          const s = firstEmptySlot()
          if (!s) {
            flashFail(b)
            return
          }
          const ok = g.equipSkillCard(s, c.id)
          if (!ok) {
            flashFail(b)
            return
          }
          overlay.remove()
          void showSkillCardsModal()
        }
        actions.appendChild(b)
      }

      cb.append(desc, actions)
      card.append(ch, cb)
      list.appendChild(card)
    }

    b.append(slotsRow, listTitle, list)
    modal.append(h, b)

    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) overlay.remove()
    })
  }

  function renderHUD(overlayActive: boolean) {
    const state = lastState
    if (!state) return
    const sim = getSimOrFallback(state)

    const topPanel = el('div')
    const bar = el('div', 'hud-topbar')

    const timeLeft = Math.max(0, config.sim.waveDurationSec - sim.waveTimeSec)

    const lvl = Math.max(0, Math.floor(state.skills?.level ?? 0))
    const xp = Math.max(0, Math.floor(state.skills?.xp ?? 0))
    const sp = Math.max(0, Math.floor(state.skills?.skillPoints ?? 0))
    const nextXP = xpToNext(lvl)

    bar.append(
      kv('Wave', String(state.wave), true),
      kv('Time', formatTimeMMSS(timeLeft), true),
      kv('Gold', formatNumber(state.gold, state.settings.numberFormat), true),
      kv('Palladium', formatPaladyumInt(state.stats.paladyumDroppedThisRun ?? 0), true),
      kv('Level', String(lvl), true),
      kv('XP', `${xp}/${nextXP}`, true),
      kv('SP', String(sp), true),
      kv('DPS', formatNumber(sim.wave.dpsSnap, state.settings.numberFormat), true),
      kv('HP', `${formatNumber(state.baseHP, 'suffix')}`, true),
    )

    const body = el('div')
    body.style.padding = '2px 10px 6px'

    // Kill ratio bar
    const kr = sim.spawnedSoFar <= 0 ? 0 : clamp(sim.killed / Math.max(1, sim.spawnedSoFar), 0, 1)
    const th = sim.wave.threshold
    const { penaltyFactor } = calcPenaltyFactor(kr, th, config)

    const line = el('div', 'hud-kpi')

    const left = el('div', 'hud-kpi-block')
    left.innerHTML = `<div class="muted hud-kpi-label">Kill Ratio</div><div class="mono hud-kpi-value">${kr.toFixed(2)} <span class="muted" style="font-size:11px">/ ${th.toFixed(2)}</span></div>`

    const right = el('div', 'hud-kpi-block hud-kpi-right')
    right.innerHTML = `<div class="muted hud-kpi-label">Penalty</div><div class="mono hud-kpi-value" style="color:${penaltyFactor < 1 ? 'var(--danger)' : 'var(--neon-lime)'}">\u00d7${penaltyFactor.toFixed(2)}</div>`

    line.append(left, right)

    const barOuter = el('div', 'bar' + (penaltyFactor < 1 ? ' warn' : ''))
    const fill = el('div', 'fill')
    fill.style.width = `${Math.floor(kr * 100)}%`
    barOuter.appendChild(fill)

    body.append(line, barOuter)

    topPanel.append(bar, body)
    top.appendChild(topPanel)

    // Bottom bar
    const bottomPanel = el('div')
    bottomPanel.style.marginTop = 'auto'
    const bb = el('div', 'bottom-bar')

    const leftStack = el('div', 'stack')
    const speed1 = btn('1\u00d7', 'btn')
    const speed2 = btn('2\u00d7', 'btn')
    const speed3 = btn('3\u00d7', 'btn')
    ;[speed1, speed2, speed3].forEach((b) => { b.style.minWidth = '36px'; b.style.textAlign = 'center' })

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

      const liveTitle = el('div', 'muted')
      liveTitle.textContent = 'LIVE'
      liveTitle.style.fontWeight = '700'
      liveTitle.style.fontSize = '10px'
      liveTitle.style.letterSpacing = '0.06em'
      liveTitle.style.marginTop = '6px'

      const live = el('div', 'muted')
      live.style.fontSize = '11px'
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
      `

      ub.append(hr(), liveTitle, live, statsBox)
      upg.append(uh, ub)

      panels.append(upg)
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
    )

    body.appendChild(hr())

    const breakdown = el('div', 'muted')
    breakdown.style.fontSize = '12px'
    breakdown.innerHTML = `<div style="font-weight:800">Breakdown</div>`

    const row = (label: string, text: string) => {
      const d = el('div', 'muted')
      d.innerHTML = `• <span style="font-weight:800">${label}:</span> ${text}`
      return d
    }

    breakdown.append(
      row(
        'Damage/shot',
        `base ${formatNumber(t.baseDamage, lastState!.settings.numberFormat)} × skills ${t.skills.dmgMult.toFixed(3)} = <span class="mono">${formatNumber(t.damagePerShot, lastState!.settings.numberFormat)}</span>`,
      ),
      row(
        'Fire rate',
        `base ${t.fireRateBase.toFixed(3)}/s × (1 ${t.skills.fireRateBonus >= 0 ? '+' : ''}${(t.skills.fireRateBonus * 100).toFixed(1)}%) = <span class="mono">${t.fireRateFinal.toFixed(3)}/s</span>`,
      ),
      row(
        'Range',
        `base <span class="mono">${Math.floor(t.rangeBase)}</span>`,
      ),
      row(
        'Armor Pierce',
        `base ${formatPct(config.tower.armorPierce0)} + ${formatPct(t.armorPierceBonus)} (upgrade) + ${formatPct(t.skills.armorPierceBonus)} (skills) = <span class="mono">${formatPct(t.armorPierceFinal)}</span>`,
      ),
      row(
        'Targets',
        `upgrade <span class="mono">${t.baseTargets}</span>`,
      ),
      row(
        'Max HP',
        `<span class="mono">${formatNumber(t.maxHP, lastState!.settings.numberFormat)}</span>`,
      ),
      row(
        'Slow',
        `<span class="mono">${t.slowFinalMult.toFixed(3)}</span>`,
      ),
      row(
        'Gold Mult',
        `<span class="mono">x${t.goldMultFinal.toFixed(3)}</span>`,
      ),
    )

    body.appendChild(breakdown)

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

    const audio = el('div')
    audio.innerHTML = `<div style="font-weight:800">Audio</div>`

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
    }

    slider.onchange = () => {
      if (!game || !lastState) return
    }

    audio.appendChild(slider)

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
        <div style="font-weight:900; margin-bottom:6px">Economy: Gold & Palladium</div>
        <div>• <b>Gold</b>: used for in-run upgrades (damage, fire rate, range, etc.).</div>
        <div>• <b>Palladium</b>: permanent meta currency (Meta Upgrades, Skills, Lab).</div>
        <div>• Palladium is granted deterministically at wave end (affected by your performance).</div>
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
        <div style="font-weight:900; margin-bottom:6px">Skills (XP / Level / Skill Points)</div>
        <div>Skills are a permanent progression layer that gives small, controlled bonuses.</div>
        <div>• You gain <b>XP at wave end</b>. Higher waves grant more XP via a wave multiplier.</div>
        <div>• When you <b>level up</b>, you gain <b>1 Skill Point</b>.</div>
        <div>• Spend Skill Points in the <b>Skills</b> menu (Attack / Defense / Utility).</div>
        <div>• Tiers are gated per-branch: Tier 2 / 3 / 4 unlock at <b>2 / 4 / 6</b> skills in the same branch.</div>
        <div>• You can <b>Respec</b> all skills for <b>Palladium</b>; the cost increases each time.</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">Skill Cards (3 Slots)</div>
        <div>Skill Cards are a <b>loadout</b> system: equip up to <b>3</b> cards to add flashy combat effects.</div>
        <div>• Open <b>Skill Cards</b> and press <b>Equip</b> to place a card into the first empty slot.</div>
        <div>• There is <b>no cost</b> to equip/unequip cards. (You only need a free slot.)</div>
        <div>• You can equip <b>each card at most once</b> at a time.</div>
        <div class="mono" style="margin-top:6px">Tip: Combine a damage card (Laser / UZI / Lightning) with a control card (Freeze / Wall) for smoother KR.</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">What Does Deterministic (No RNG) Mean?</div>
        <div>With the same wave, the same upgrades, and the same settings, the game produces the same outcomes.</div>
        <div>This makes balance and build experiments easier to read: decisions matter more than luck.</div>
      </div>

      <div style="height:10px"></div>

      <div class="muted">
        <div style="font-weight:900; margin-bottom:6px">Tips</div>
        <div>• If you miss the KR target: stabilize DPS first (damage/fire rate), then add survivability.</div>
        <div>• If too many enemies escape: range + slow + baseHP/repair combos are strong.</div>
        <div>• If you just leveled up: spend Skill Points in Skills to smooth out your build.</div>
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

    const xpInfo = typeof report.xpGain === 'number' && Number.isFinite(report.xpGain)
      ? `<div class="muted">XP: <span class="mono">+${Math.max(0, Math.floor(report.xpGain))}</span> • Wave XP Mult: <span class="mono">x${(report.xpMultiplier ?? 1).toFixed(2)}</span> • Level: <span class="mono">${report.levelBefore ?? 0} → ${report.levelAfter ?? (report.levelBefore ?? 0)}</span></div>`
      : ''

    b.innerHTML = `
      <div class="muted">Killed: <span class="mono">${report.killed}</span> • Escaped: <span class="mono">${report.escaped}</span></div>
      <div class="muted">KR: <span class="mono">${report.killRatio.toFixed(2)}</span> • Target: <span class="mono">${report.threshold.toFixed(2)}</span></div>
      <div class="muted">Reward: <span class="mono">${formatNumber(report.rewardGold, lastState?.settings.numberFormat ?? 'suffix')}</span> gold • <span class="mono">${formatPaladyumInt(report.rewardPoints)}</span> Palladium</div>
      ${xpInfo}
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
        if (screen === 'hud' || screen === 'settings' || screen === 'stats') {
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
