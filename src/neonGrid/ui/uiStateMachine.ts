import type { GameConfig, GameState, OfflineProgressResult, RunSummary, WaveReport } from '../types'
import type { NeonGridGame } from '../phaser/createGame'
import type { SimPublic } from '../sim/SimEngine'
import { btn, clear, el, hr, kv } from './dom'
import { formatNumber, formatPct, formatTimeMMSS } from './format'
import { calcPenaltyFactor, calcWaveSnapshot, clamp, calcDPS } from '../sim/deterministic'
import { moduleUnlockCostPoints, moduleUpgradeCostGold, upgradeCost } from '../sim/costs'

export type UIScreen = 'boot' | 'menu' | 'hud' | 'modules' | 'prestige' | 'settings' | 'stats' | 'offline'

type UIArgs = {
  root: HTMLElement
  config: GameConfig
  initialState: UIScreen
  offlineResult: OfflineProgressResult
}

export function createUIStateMachine(args: UIArgs) {
  const { root, config } = args

  // In dev/HMR or accidental re-init, multiple UI layers can stack and swallow clicks.
  // Reset the UI root so only one active layer exists.
  clear(root)

  // Some runtimes end up not dispatching native 'click' for pointer interactions.
  // Bridge pointerdown -> onclick for our UI buttons, and suppress the follow-up click
  // to avoid double-firing when native click *does* occur.
  if (!(root as any).__ngBtnBridgeInstalled) {
    ;(root as any).__ngBtnBridgeInstalled = true
    const lastSyntheticAt = new WeakMap<HTMLButtonElement, number>()

    root.addEventListener(
      'pointerdown',
      (e) => {
        const pe = e as PointerEvent
        if (!pe.isPrimary) return
        if (typeof pe.button === 'number' && pe.button !== 0) return

        const target = pe.target as Element | null
        const button = target?.closest?.('button[data-ng-btn="1"]') as HTMLButtonElement | null
        if (!button || button.disabled) return

        lastSyntheticAt.set(button, performance.now())
        // Prevent focus/selection quirks and help avoid an additional native click.
        pe.preventDefault()

        const handler = button.onclick
        if (handler) {
          handler.call(button, new MouseEvent('click', { bubbles: true, cancelable: true, view: window }) as any)
        }
      },
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

  let screen: UIScreen = args.initialState

  const top = el('div', 'hud-top')
  const center = el('div')
  center.style.flex = '1'
  center.style.minHeight = '0'
  center.style.overflow = 'auto'
  const bottom = el('div')

  layer.append(top, center, bottom)

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
      timeScale: 1,
      paused: true,
      auto: true,
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

  function setScreen(next: UIScreen) {
    screen = next
    render()
  }

  function render() {
    cleanupStaleModalOverlays()

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

    if (screen === 'modules') renderModules()
    if (screen === 'prestige') renderPrestige()
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
    p.textContent = 'Deterministik simülasyon başlatılıyor…'
    p.style.marginBottom = '10px'

    const bar = el('div', 'bar')
    const fill = el('div', 'fill')
    fill.style.width = '0%'
    bar.appendChild(fill)

    const tip = el('div', 'muted')
    tip.style.marginTop = '10px'

    const tips = config.ui.tipsTR
    const dayIndex = Math.floor(Date.now() / 86400_000)
    tip.textContent = `İpucu: ${tips[dayIndex % tips.length]}`

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
    const panel = el('div', 'panel')
    panel.style.maxWidth = '560px'
    panel.style.margin = 'auto'

    const header = el('div', 'panel-header')
    const title = el('div')
    title.textContent = 'NEON GRID'
    header.appendChild(title)

    const ver = el('div', 'muted mono')
    ver.textContent = `v${config.version}`
    header.appendChild(ver)

    const body = el('div', 'panel-body')

    const desc = el('div', 'muted')
    desc.textContent = 'Raslantı yok: Tüm sonuçlar deterministiktir. Dalga süresi sabittir.'

    const row = el('div', 'stack')
    row.style.marginTop = '12px'

    const cont = btn('Devam Et', 'btn btn-primary')
    cont.onclick = () => {
      if (!game) return
      game.setPaused(false)
      setScreen('hud')
    }

    const newRun = btn('Yeni Koşu', 'btn')
    newRun.onclick = () => {
      if (!game) return
      game.newRun()
      setScreen('hud')
    }

    const settings = btn('Ayarlar', 'btn')
    settings.onclick = () => setScreen('settings')

    const credits = btn('Credits', 'btn')
    credits.onclick = () => {
      alert('NEON GRID — Deterministic Idle Tower Defense\nUI/Sim prototype skeleton.')
    }

    row.append(cont, newRun, settings, credits)

    const card = el('div', 'panel')
    card.style.marginTop = '12px'
    const ch = el('div', 'panel-header')
    ch.textContent = 'No RNG Mode'
    const cb = el('div', 'panel-body')
    cb.innerHTML = `
      <div class="muted">• Spawn düzeni, enemy tipi, ödül ve ceza: deterministik formüllerle.</div>
      <div class="muted">• Kill Ratio hedefi tutmazsa: ödül çarpanı düşer, kaçanlar base’e ekstra hasar verir.</div>
      <div class="muted">• Her dalga tam ${config.sim.waveDurationSec.toFixed(1)}s sürer.</div>
    `
    card.append(ch, cb)

    body.append(desc, row, card)
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
      kv('Dalga', String(state.wave), true),
      kv('Süre', formatTimeMMSS(timeLeft), true),
      kv('Altın', formatNumber(state.gold, state.settings.numberFormat), true),
      kv('Puan', formatNumber(state.points, state.settings.numberFormat), true),
      kv('DPS (snap)', formatNumber(sim.wave.dpsSnap, state.settings.numberFormat), true),
      kv('HP', `${formatNumber(state.baseHP, 'suffix')}`, true),
    )

    const body = el('div', 'panel-body')

    // Kill ratio bar
    const kr = sim.spawnedSoFar <= 0 ? 0 : clamp(sim.killed / Math.max(1, sim.spawnedSoFar), 0, 1)
    const th = sim.wave.threshold
    const { penaltyFactor } = calcPenaltyFactor(kr, th, config)

    const line = el('div')
    line.style.display = 'flex'
    line.style.alignItems = 'center'
    line.style.justifyContent = 'space-between'
    line.style.gap = '10px'

    const left = el('div')
    left.innerHTML = `<div class="muted">Öldürme Oranı</div><div class="mono" style="font-weight:800">${kr.toFixed(2)} / Hedef ${th.toFixed(2)}</div>`

    const right = el('div')
    right.innerHTML = `<div class="muted">Ceza Çarpanı</div><div class="mono" style="font-weight:800; color:${penaltyFactor < 1 ? 'var(--danger)' : 'var(--neon-lime)'}">x${penaltyFactor.toFixed(2)}</div>`

    line.append(left, right)

    const barOuter = el('div', 'bar' + (penaltyFactor < 1 ? ' warn' : ''))
    const fill = el('div', 'fill')
    fill.style.width = `${Math.floor(kr * 100)}%`
    barOuter.appendChild(fill)

    body.append(line, barOuter)
    topPanel.append(bar, body)
    top.appendChild(topPanel)

    // Bottom bar
    const bottomPanel = el('div', 'panel')
    const bb = el('div', 'bottom-bar')

    const leftStack = el('div', 'stack')
    const speed1 = btn('1x', 'btn')
    const speed2 = btn('2x', 'btn')
    const speed4 = btn('4x', 'btn')
    ;[speed1, speed2, speed4].forEach((b) => (b.style.minWidth = '58px'))
    speed1.onclick = () => game?.setTimeScale(1)
    speed2.onclick = () => game?.setTimeScale(2)
    speed4.onclick = () => game?.setTimeScale(4)

    const auto = btn(sim.auto ? 'Auto: AÇIK' : 'Auto: KAPALI', 'btn')
    auto.onclick = () => {
      game?.toggleAuto()
      render()
    }

    const pause = btn(sim.paused ? 'Devam' : 'Duraklat', 'btn')
    pause.onclick = () => {
      game?.setPaused(!sim.paused)
      render()
    }

    leftStack.append(speed1, speed2, speed4, auto, pause)

    const rightStack = el('div', 'stack')
    const upgrades = btn('Yükseltmeler', 'btn')
    upgrades.onclick = () => setScreen('hud')

    const modules = btn('Modüller', 'btn')
    modules.onclick = () => setScreen('modules')

    const stats = btn('İstatistikler', 'btn')
    stats.onclick = () => setScreen('stats')

    const prestige = btn('Prestij', 'btn')
    prestige.onclick = () => setScreen('prestige')

    const settings = btn('Ayarlar', 'btn')
    settings.onclick = () => setScreen('settings')

    rightStack.append(upgrades, modules, stats, prestige, settings)

    bb.append(leftStack, rightStack)
    bottomPanel.appendChild(bb)
    bottom.appendChild(bottomPanel)

    // Side overlay content (Upgrades quick panel)
    if (!overlayActive) {
      const panels = el('div', 'row')
      panels.style.pointerEvents = 'auto'
      panels.style.alignItems = 'stretch'

      const left = el('div', 'panel')
      left.style.width = '320px'
      left.style.pointerEvents = 'auto'

      const lh = el('div', 'panel-header')
      lh.textContent = 'Yükseltmeler'
      const lb = el('div', 'panel-body')

      lb.appendChild(renderUpgradeRow('Hasar', 'damage', state.towerUpgrades.damageLevel))
      lb.appendChild(renderUpgradeRow('Atış Hızı', 'fireRate', state.towerUpgrades.fireRateLevel))
      lb.appendChild(renderUpgradeRow('Menzil', 'range', state.towerUpgrades.rangeLevel))
      lb.appendChild(renderUpgradeRow('Base HP', 'baseHP', state.towerUpgrades.baseHPLevel))

      left.append(lh, lb)

      const right = el('div', 'panel')
      right.style.width = '320px'
      right.style.pointerEvents = 'auto'

      const rh = el('div', 'panel-header')
      rh.textContent = 'Canlı Rapor'
      const rb = el('div', 'panel-body')

      const live = el('div', 'muted')
      live.innerHTML = `
        <div>Spawn: <span class="mono">${sim.spawnedSoFar}/${sim.wave.spawnCount}</span></div>
        <div>Öldürülen: <span class="mono">${sim.killed}</span></div>
        <div>Kaçan: <span class="mono">${sim.escaped}</span></div>
        <div>Beklenen Ceza: <span class="mono">x${penaltyFactor.toFixed(2)}</span></div>
      `

      const dpsNow = calcDPS(state, config)
      const statsBox = el('div', 'muted')
      statsBox.style.marginTop = '10px'
      statsBox.innerHTML = `
        <div>Build DPS (anlık): <span class="mono">${formatNumber(dpsNow, state.settings.numberFormat)}</span></div>
        <div>Zırh Delme: <span class="mono">${formatPct(sim.tower.armorPierce)}</span></div>
      `

      rb.append(live, hr(), statsBox)
      right.append(rh, rb)

      const spacer = el('div')
      spacer.style.flex = '1'
      spacer.style.pointerEvents = 'none'
      panels.append(left, spacer, right)
      center.appendChild(panels)
    }
  }

  function renderUpgradeRow(label: string, key: 'damage' | 'fireRate' | 'range' | 'baseHP', level: number): HTMLElement {
    const box = el('div')
    box.style.display = 'grid'
    box.style.gridTemplateColumns = '1fr auto'
    box.style.gap = '10px'
    box.style.alignItems = 'center'
    box.style.marginBottom = '10px'

    const left = el('div')
    left.innerHTML = `<div style="font-weight:800">${label}</div><div class="muted mono">Lv ${level} • Sonraki: ${formatNumber(upgradeCost(level, config), lastState?.settings.numberFormat ?? 'suffix')}</div>`

    const controls = el('div', 'stack')
    const b1 = btn('+1', 'btn')
    const b10 = btn('+10', 'btn')
    const bM = btn('+Max', 'btn')

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

  function renderModules() {
    if (!game || !lastState) return

    const panel = el('div', 'panel')
    panel.style.maxWidth = '920px'
    panel.style.margin = '0 auto'
    panel.style.pointerEvents = 'auto'
    // Fill available center space so the body can actually scroll.
    panel.style.height = '100%'
    panel.style.maxHeight = '100%'
    panel.style.display = 'flex'
    panel.style.flexDirection = 'column'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Modüller'

    const back = btn('Geri', 'btn')
    back.onclick = () => setScreen('hud')
    header.appendChild(back)

    const body = el('div', 'panel-body')
    body.style.flex = '1'
    body.style.minHeight = '0'
    body.style.overflow = 'auto'

    const filterRow = el('div', 'stack')

    const mkFilter = (label: string, f: typeof modulesFilter) => {
      const b = btn(label, 'btn')
      b.onclick = () => {
        modulesFilter = f
        render()
      }
      return b
    }

    filterRow.append(mkFilter('Tümü', 'ALL'), mkFilter('OFFENSE', 'OFFENSE'), mkFilter('DEFENSE', 'DEFENSE'), mkFilter('UTILITY', 'UTILITY'))

    const list = el('div')
    list.style.display = 'grid'
    list.style.gridTemplateColumns = 'repeat(auto-fit, minmax(240px, 1fr))'
    list.style.gap = '10px'
    list.style.marginTop = '12px'

    const unlockedCount = Object.values(lastState.modulesUnlocked).filter(Boolean).length

    for (const def of config.modules.defs) {
      if (modulesFilter !== 'ALL' && def.category !== modulesFilter) continue

      const card = el('div', 'panel')
      const ch = el('div', 'panel-header')
      const name = el('div')
      name.textContent = def.nameTR

      const cat = el('div', 'muted mono')
      cat.textContent = def.category
      ch.append(name, cat)

      const cb = el('div', 'panel-body')

      const effect = el('div', 'muted')
      effect.textContent = moduleEffectText(def)

      const icon = el('div', 'muted')
      icon.style.marginTop = '6px'
      icon.textContent = `İkon: ${def.iconConcept}`

      const actions = el('div', 'stack')
      actions.style.marginTop = '10px'

      const isUnlocked = !!lastState.modulesUnlocked[def.id]
      if (!isUnlocked) {
        const cost = moduleUnlockCostPoints(unlockedCount, config)
        const b = btn(`Aç (${cost} puan)`, 'btn btn-primary')
        b.onclick = () => {
          if (!game) return
          const ok = game.unlockModule(def.id)
          if (!ok) {
            flashFail(b)
            return
          }
          lastState = game.getSnapshot()
          render()
        }
        actions.appendChild(b)
      } else {
        const level = lastState.moduleLevels[def.id] ?? 0
        const cost = moduleUpgradeCostGold(level, config)

        const b1 = btn(`+1 (₲${formatNumber(cost, lastState.settings.numberFormat)})`, 'btn')
        b1.onclick = () => {
          if (!game) return
          const ok = game.upgradeModule(def.id, 1)
          if (!ok) {
            flashFail(b1)
            return
          }
          lastState = game.getSnapshot()
          render()
        }
        const b10 = btn('+10', 'btn')
        b10.onclick = () => {
          if (!game) return
          const ok = game.upgradeModule(def.id, 10)
          if (!ok) {
            flashFail(b10)
            return
          }
          lastState = game.getSnapshot()
          render()
        }
        const bM = btn('+Max', 'btn')
        bM.onclick = () => {
          if (!game) return
          const ok = game.upgradeModule(def.id, 'max')
          if (!ok) {
            flashFail(bM)
            return
          }
          lastState = game.getSnapshot()
          render()
        }

        actions.append(kv('Seviye', String(level), true), b1, b10, bM)
      }

      cb.append(effect, icon, actions)
      card.append(ch, cb)
      list.appendChild(card)
    }

    body.append(filterRow, list)
    panel.append(header, body)
    center.appendChild(panel)
  }

  function moduleEffectText(def: GameConfig['modules']['defs'][number]): string {
    const parts: string[] = []
    if (def.dmgMultPerLevel) parts.push(`Hasar Çarpanı: +${(def.dmgMultPerLevel * 100).toFixed(1)}% / seviye`)
    if (def.dmgFlatPerLevel) parts.push(`Düz Hasar: +${def.dmgFlatPerLevel} / seviye`)
    if (def.fireRateBonusPerLevel) parts.push(`Atış Hızı: +${(def.fireRateBonusPerLevel * 100).toFixed(1)}% / seviye`)
    if (def.rangeBonusPerLevel) parts.push(`Menzil: +${def.rangeBonusPerLevel} / seviye`)
    if (def.armorPiercePerLevel) parts.push(`Zırh Delme: +${(def.armorPiercePerLevel * 100).toFixed(1)}% / seviye`)
    if (def.baseHPBonusPerLevel) parts.push(`Base HP: +${def.baseHPBonusPerLevel} / seviye`)
    if (def.goldMultPerLevel) parts.push(`Altın Çarpanı: +${(def.goldMultPerLevel * 100).toFixed(1)}% / seviye`)

    return parts.length ? parts.join(' • ') : 'Etki: (tanımlı değil)'
  }

  function renderPrestige() {
    if (!game || !lastState) return

    const panel = el('div', 'panel')
    panel.style.maxWidth = '720px'
    panel.style.margin = 'auto'
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'RESET PROTOCOL'

    const back = btn('Geri', 'btn')
    back.onclick = () => setScreen('hud')
    header.appendChild(back)

    const body = el('div', 'panel-body')

    const run = el('div', 'muted')
    run.innerHTML = `
      <div>En Yüksek Dalga: <span class="mono">${lastState.stats.bestWave}</span></div>
      <div>Toplam Süre: <span class="mono">${formatTimeMMSS(lastState.stats.totalTimeSec)}</span></div>
      <div>Prestij Puanı: <span class="mono">${lastState.prestigePoints}</span></div>
    `

    const preview = el('div', 'muted')
    preview.style.marginTop = '10px'
    preview.textContent = 'Prestij çarpanı: 1 + μ·sqrt(P). (Deterministik)'

    const confirmBox = el('div', 'panel')
    confirmBox.style.marginTop = '12px'

    const ch = el('div', 'panel-header')
    ch.textContent = 'Onay'

    const cb = el('div', 'panel-body')
    const hold = btn('Basılı Tut: Onayla', 'btn btn-danger')
    hold.style.width = '100%'

    let timer: number | null = null
    hold.onpointerdown = () => {
      hold.textContent = 'Tutmaya devam…'
      timer = window.setTimeout(() => {
        timer = null
        const res = game!.prestigeReset()
        if (!res.ok) {
          alert('Prestij için yeterli koşul yok (şimdilik).')
        } else {
          alert(`Prestij kazanıldı: +${res.gained}`)
          setScreen('hud')
        }
      }, 900)
    }

    const cancel = () => {
      if (timer) window.clearTimeout(timer)
      timer = null
      hold.textContent = 'Basılı Tut: Onayla'
    }

    hold.onpointerup = cancel
    hold.onpointerleave = cancel
    hold.onpointercancel = cancel

    cb.appendChild(hold)
    confirmBox.append(ch, cb)

    body.append(run, preview, confirmBox)
    panel.append(header, body)
    center.appendChild(panel)
  }

  function renderSettings() {
    if (!game || !lastState) return

    const panel = el('div', 'panel')
    panel.style.maxWidth = '820px'
    panel.style.margin = 'auto'
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Ayarlar'

    const back = btn('Geri', 'btn')
    back.onclick = () => setScreen('hud')
    header.appendChild(back)

    const body = el('div', 'panel-body')

    const audio = el('div')
    audio.innerHTML = `<div style="font-weight:800">Ses</div>`
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '0'
    slider.max = '1'
    slider.step = '0.01'
    slider.value = String(lastState.settings.audioMaster)
    slider.oninput = () => {
      lastState!.settings.audioMaster = Number(slider.value)
      game!.setSnapshot({ ...lastState! })
    }
    audio.appendChild(slider)

    const quality = el('div')
    quality.style.marginTop = '12px'
    quality.innerHTML = `<div style="font-weight:800">Kalite</div>`

    const select = document.createElement('select')
    select.className = 'btn'
    select.style.width = '100%'
    ;['low', 'med', 'high'].forEach((q) => {
      const o = document.createElement('option')
      o.value = q
      o.textContent = q.toUpperCase()
      if (lastState!.settings.quality === q) o.selected = true
      select.appendChild(o)
    })
    select.onchange = () => {
      lastState!.settings.quality = select.value as any
      game!.setSnapshot({ ...lastState! })
    }
    quality.appendChild(select)

    const nf = el('div')
    nf.style.marginTop = '12px'
    nf.innerHTML = `<div style="font-weight:800">Sayı Formatı</div>`

    const nfRow = el('div', 'stack')
    const suf = btn('Suffix', 'btn')
    const sci = btn('Scientific', 'btn')
    suf.onclick = () => {
      lastState!.settings.numberFormat = 'suffix'
      game!.setSnapshot({ ...lastState! })
    }
    sci.onclick = () => {
      lastState!.settings.numberFormat = 'scientific'
      game!.setSnapshot({ ...lastState! })
    }
    nfRow.append(suf, sci)

    const reduce = el('div')
    reduce.style.marginTop = '12px'
    const chk = document.createElement('input')
    chk.type = 'checkbox'
    chk.checked = lastState.settings.reduceEffects
    chk.onchange = () => {
      lastState!.settings.reduceEffects = chk.checked
      game!.setSnapshot({ ...lastState! })
    }
    const lbl = el('label', 'muted')
    lbl.style.display = 'flex'
    lbl.style.gap = '10px'
    lbl.style.alignItems = 'center'
    lbl.append(chk, document.createTextNode('Efektleri azalt (motion/glow)'))
    reduce.appendChild(lbl)

    const savePanel = el('div', 'panel')
    savePanel.style.marginTop = '12px'
    const sh = el('div', 'panel-header')
    sh.textContent = 'Save Export/Import'
    const sb = el('div', 'panel-body')

    const ta = document.createElement('textarea')
    ta.className = 'mono'
    ta.style.width = '100%'
    ta.style.minHeight = '120px'
    ta.placeholder = 'Save text…'

    const exportBtn = btn('Export', 'btn')
    exportBtn.onclick = async () => {
      ta.value = JSON.stringify(game!.getSnapshot())
      await navigator.clipboard.writeText(ta.value)
      alert('Kopyalandı.')
    }

    const importBtn = btn('Import (Replace)', 'btn btn-danger')
    importBtn.onclick = () => {
      try {
        const parsed = JSON.parse(ta.value)
        game!.setSnapshot(parsed)
        alert('Yüklendi.')
      } catch {
        alert('Geçersiz metin.')
      }
    }

    sb.append(ta, el('div', 'stack'))
    sb.lastElementChild!.append(exportBtn, importBtn)
    savePanel.append(sh, sb)

    body.append(audio, quality, nf, nfRow, reduce, savePanel)
    panel.append(header, body)
    center.appendChild(panel)
  }

  function renderStats() {
    if (!lastState) return

    const panel = el('div', 'panel')
    panel.style.maxWidth = '920px'
    panel.style.margin = 'auto'
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Codex / İstatistikler'

    const back = btn('Geri', 'btn')
    back.onclick = () => setScreen('hud')
    header.appendChild(back)

    const body = el('div', 'panel-body')

    body.append(
      kv('Toplam Öldürme', String(lastState.stats.totalKills), true),
      kv('Toplam Kaçış', String(lastState.stats.totalEscapes), true),
      kv('En Yüksek Dalga', String(lastState.stats.bestWave), true),
      kv('Koşu Sayısı', String(lastState.stats.runsCount), true),
    )

    body.appendChild(hr())

    const enemy = el('div', 'muted')
    enemy.innerHTML = `<div style="font-weight:800">Enemy Tipleri</div>`
    for (const t of config.enemies.types) {
      const row = el('div', 'muted')
      row.innerHTML = `• <span class="mono">${t.id}</span> — ${t.nameTR} (hp×${t.hpMult}, armor×${t.armorMult})`
      enemy.appendChild(row)
    }

    const formula = el('div', 'muted')
    formula.style.marginTop = '10px'
    formula.innerHTML = `
      <div style="font-weight:800">Deterministik Formüller</div>
      <div class="mono">enemy_type(w,i) = (A·w + B·i + C) mod K</div>
      <div class="mono">t_i = T · (i/N)^p</div>
      <div class="mono">TotalEHP(w) = DPS_snap · T · ρ · G(w)</div>
    `

    body.append(enemy, formula)
    panel.append(header, body)
    center.appendChild(panel)
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
      <div class="muted">Öldürülen: <span class="mono">${report.killed}</span> • Kaçan: <span class="mono">${report.escaped}</span></div>
      <div class="muted">KR: <span class="mono">${report.killRatio.toFixed(2)}</span> • Hedef: <span class="mono">${report.threshold.toFixed(2)}</span></div>
      <div class="muted">Ödül: <span class="mono">${formatNumber(report.rewardGold, lastState?.settings.numberFormat ?? 'suffix')}</span> altın • <span class="mono">${report.rewardPoints}</span> puan</div>
      <div class="muted" style="margin-top:6px; color:${warn ? 'var(--danger)' : 'var(--neon-lime)'}">Ceza Çarpanı: <span class="mono">x${report.penaltyFactor.toFixed(2)}</span></div>
    `

    const c = btn('Devam', 'btn btn-primary')
    const overlay = mountModal(modal)
    c.onclick = () => {
      overlay.remove()
    }

    const row = el('div', 'stack')
    row.style.marginTop = '10px'
    row.appendChild(c)
    b.appendChild(row)

    modal.append(h, b)
    window.setTimeout(() => {
      if (overlay.isConnected) {
        overlay.remove()
      }
    }, config.sim.autoOverlayCloseSec * 1000)
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
      <div class="muted">Süre: <span class="mono">${formatTimeMMSS(result.elapsedSec)}</span></div>
      <div class="muted">Tahmini dalga: <span class="mono">${result.offlineWaves}</span></div>
      <div class="muted">Kazanç: <span class="mono">${formatNumber(result.gainedGold, lastState?.settings.numberFormat ?? 'suffix')}</span> (x${result.factorApplied.toFixed(2)})</div>
      <div class="muted" style="margin-top:6px">Not: ${result.estimatedKillRatioNoteTR}</div>
    `

    const overlay = mountModal(modal)

    const collect = btn('Topla', 'btn btn-primary')
    collect.onclick = () => {
      if (!game) return
      game.setSnapshot(result.stateAfter)
      game.setPaused(false)
      overlay.remove()
      setScreen('menu')
    }

    const ad = btn('2x için Reklam İzle (deterministik çarpan)', 'btn')
    ad.onclick = () => {
      alert('Bu prototipte reklam yok; çarpan demo amaçlı. İstersen UI entegrasyonu ekleriz.')
    }

    const row = el('div', 'stack')
    row.style.marginTop = '10px'
    row.append(collect, ad)
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
      <div class="muted">Bittiği Dalga: <span class="mono">${summary.endedAtWave}</span></div>
      <div class="muted">Toplam Altın: <span class="mono">${formatNumber(summary.totalGoldThisRun, lastState?.settings.numberFormat ?? 'suffix')}</span></div>
      <div class="muted">Süre: <span class="mono">${formatTimeMMSS(summary.totalTimeSec)}</span></div>
    `

    const overlay = mountModal(modal)

    const row = el('div', 'stack')
    row.style.marginTop = '10px'

    const menu = btn('Menü', 'btn')
    menu.onclick = () => {
      overlay.remove()
      setScreen('menu')
    }

    const newRun = btn('Yeni Koşu', 'btn btn-primary')
    newRun.onclick = () => {
      overlay.remove()
      game?.newRun()
      setScreen('hud')
    }

    row.append(menu, newRun)
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
        if (screen === 'hud' || screen === 'modules' || screen === 'prestige' || screen === 'settings' || screen === 'stats') {
          render()
        }
      })
    })

    // Initial render once state is available.
    lastState = g.getSnapshot()
    lastSim = null
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
