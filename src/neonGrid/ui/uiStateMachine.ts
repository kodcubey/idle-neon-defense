import type { GameConfig, GameState, OfflineProgressResult, RunSummary, TowerUpgradeKey, WaveReport } from '../types'
import type { NeonGridGame } from '../phaser/createGame'
import type { SimPublic } from '../sim/SimEngine'
import { applyMetaToState, type FirebaseSync } from '../persistence/firebaseSync'
import { createNewState, saveSnapshot } from '../persistence/save'
import { btn, clear, el, hr, kv } from './dom'
import { formatNumber, formatPaladyum, formatPaladyumInt, formatPct, formatTimeMMSS } from './format'
import { calcPenaltyFactor, calcWaveSnapshot, clamp, calcDPS, aggregateModules } from '../sim/deterministic'
import { moduleSlotUnlockCostPoints, moduleUnlockCostPoints, moduleUpgradeCostPoints, upgradeCost, upgradeMaxLevel } from '../sim/costs'

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
          game!.setSnapshot(applyMetaToState(cur, cloudMeta))
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
    const panel = el('div', 'panel ng-menu')
    panel.style.width = 'min(560px, calc(100vw - 24px))'
    panel.style.margin = '18px auto'

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

    const balances = el('div', 'muted')
    balances.style.marginTop = '10px'
    const pal = lastState?.points ?? 0
    balances.innerHTML = `Paladyum: <span class="mono">${formatPaladyum(pal)}</span>`

    const row = el('div', 'stack ng-menu-actions')
    row.style.marginTop = '12px'

    const cont = btn('Continue', 'btn btn-primary')
    cont.onclick = () => {
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
                game!.setSnapshot(applyMetaToState(cur, cloudMeta))
                lastState = game!.getSnapshot()
              }
            })
          } catch (e) {
            alert(String((e as any)?.message ?? e))
          }
        }

        game.setPaused(false)
        setScreen('hud')
      })()
    }

    const newRun = btn('New Run', 'btn')
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
                game!.setSnapshot(applyMetaToState(cur, cloudMeta))
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

    const modules = btn('Modules', 'btn')
    modules.onclick = () => {
      void (async () => {
        if (game) game.setPaused(true)

        // On entering Modules, refresh meta from cloud (if signed in) so
        // equipped slots/levels don't "pop in" after a delayed sync.
        const st = firebaseSync?.getStatus()
        const canCloud = !!firebaseSync && !!st?.configured && !!st?.signedIn
        if (canCloud) {
          try {
            await withLoading(async () => {
              await maybeInitialCloudSync()
              if (!game) return
              const cloudMeta = await firebaseSync!.downloadMeta()
              if (!cloudMeta) {
                // Best-effort: if doc doesn't exist, create it from local.
                await firebaseSync!.uploadMetaFromState(game.getSnapshot())
                return
              }
              const cur = game.getSnapshot()
              game.setSnapshot(applyMetaToState(cur, cloudMeta))
              lastState = game.getSnapshot()
            })
          } catch (e) {
            alert(String((e as any)?.message ?? e))
          }
        }

        setScreen('modules')
      })()
    }

    const stats = btn('Stats', 'btn')
    stats.onclick = () => {
      if (game) game.setPaused(true)
      setScreen('stats')
    }

    const settings = btn('Settings', 'btn')
    settings.onclick = () => {
      if (game) game.setPaused(true)
      setScreen('settings')
    }

    const credits = btn('Credits', 'btn')
    credits.onclick = () => {
      alert('NEON GRID — Deterministic Idle Tower Defense\nUI/Sim prototype skeleton.')
    }

    row.append(cont, newRun, modules, stats, settings, credits)

    const card = el('div', 'panel')
    card.style.marginTop = '12px'
    const ch = el('div', 'panel-header')
    ch.textContent = 'No RNG Mode'
    const cb = el('div', 'panel-body')
    cb.innerHTML = `
      <div class="muted">• Spawn order, enemy types, rewards and penalties are computed via deterministic formulas.</div>
      <div class="muted">• If you miss the Kill Ratio target: reward multiplier drops, and escapes deal extra damage to the base.</div>
      <div class="muted">• Each wave lasts exactly ${config.sim.waveDurationSec.toFixed(1)}s.</div>
    `
    card.append(ch, cb)

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

    if (authLine) {
      authLine.style.marginTop = '10px'
      body.appendChild(authLine)
    }

    body.append(desc, balances, row, card)
    if (authPanel) body.appendChild(authPanel)
    if (signedInPanel) body.appendChild(signedInPanel)
    panel.append(header, body)
    center.appendChild(panel)
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
    const upgrades = btn('Upgrades', 'btn')
    upgrades.onclick = () => showUpgradesModal()

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

    rightStack.append(upgrades, menu)

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

      const dpsNow = calcDPS(state, config)
      const statsBox = el('div', 'muted')
      statsBox.style.fontSize = '12px'
      statsBox.style.marginTop = '6px'
      statsBox.innerHTML = `
        <div>Build DPS: <span class="mono">${formatNumber(dpsNow, state.settings.numberFormat)}</span></div>
        <div>Armor Pierce: <span class="mono">${formatPct(sim.tower.armorPierce)}</span></div>
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

    if (atMax) {
      b1.disabled = true
      b10.disabled = true
      bM.disabled = true
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

  function renderModules() {
    if (!game || !lastState) return

    const panel = el('div', 'panel')
    panel.style.maxWidth = '920px'
    panel.style.margin = '0 auto'
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Modules'

    const back = btn('Back', 'btn')
    back.onclick = () => setScreen('menu')
    header.appendChild(back)

    const body = el('div', 'panel-body')

    const bal = el('div', 'muted')
    bal.style.marginBottom = '8px'
    bal.innerHTML = `Paladyum: <span class="mono">${formatPaladyum(lastState.points)}</span>`

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
          render()
          return ok
        } catch (e) {
          alert(String((e as any)?.message ?? e))
          lastState = game.getSnapshot()
          render()
          return false
        }
      }

      const ok = doLocal()
      if (ok) render()
      return ok
    }

    const slotsGrid = el('div')
    slotsGrid.style.display = 'grid'
    slotsGrid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(150px, 1fr))'
    slotsGrid.style.gap = '8px'

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
          effect.textContent = def ? moduleEffectText(def) : ''

          bb.append(title, effect)

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
        if (!game) return
        const ok = game.unlockModuleSlot()
        if (!ok) {
          flashFail(buy)
          return
        }
        lastState = game.getSnapshot()
        render()
      }
      sb.appendChild(buy)
    }

    slotsPanel.append(sh, sb)

    // Filter row
    const filterRow = el('div', 'stack')
    const mkFilter = (label: string, f: typeof modulesFilter) => {
      const b = btn(label, 'btn')
      if (modulesFilter === f) b.classList.add('is-selected')
      b.onclick = () => {
        modulesFilter = f
        modulesPage = 0
        render()
      }
      return b
    }
    filterRow.append(mkFilter('All', 'ALL'), mkFilter('Offense', 'OFFENSE'), mkFilter('Defense', 'DEFENSE'), mkFilter('Utility', 'UTILITY'))

    // Filter modules
    const filtered = config.modules.defs.filter((d) => modulesFilter === 'ALL' || d.category === modulesFilter)
    const totalPages = Math.max(1, Math.ceil(filtered.length / MODULES_PER_PAGE))
    if (modulesPage >= totalPages) modulesPage = totalPages - 1
    const pageItems = filtered.slice(modulesPage * MODULES_PER_PAGE, (modulesPage + 1) * MODULES_PER_PAGE)

    const unlockedCount = Object.values(lastState.modulesUnlocked).filter(Boolean).length

    const list = el('div')
    list.style.display = 'grid'
    list.style.gridTemplateColumns = 'repeat(auto-fit, minmax(240px, 1fr))'
    list.style.gap = '8px'
    list.style.marginTop = '8px'

    for (const def of pageItems) {
      const card = el('div', 'panel')
      card.draggable = false
      card.ondragstart = null
      const ch = el('div', 'panel-header')
      const name = el('div')
      name.textContent = def.nameTR

      const cat = el('div', 'muted mono')
      cat.textContent = def.category
      ch.append(name, cat)

      const cb = el('div', 'panel-body')

      const effect = el('div', 'muted')
      effect.style.fontSize = '12px'
      effect.textContent = moduleEffectText(def)

      const actions = el('div', 'stack')
      actions.style.marginTop = '6px'

      const isUnlocked = !!lastState.modulesUnlocked[def.id]
      if (!isUnlocked) {
        const cost = moduleUnlockCostPoints(unlockedCount, config)
        const b = btn(`Unlock (${formatPaladyumInt(cost)} Paladyum)`, 'btn btn-primary')
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
        const eqSlot = equippedById.get(def.id) ?? null
        const add = btn(eqSlot ? `Equipped (S${eqSlot})` : 'Add', 'btn')
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

        const b1 = btn(`+1 (${formatPaladyumInt(cost)} Paladyum)`, 'btn')
        b1.onclick = () => {
          if (!game) return
          const ok = game.upgradeModule(def.id, 1)
          if (!ok) { flashFail(b1); return }
          lastState = game.getSnapshot()
          render()
        }
        const b10 = btn('+10', 'btn')
        b10.onclick = () => {
          if (!game) return
          const ok = game.upgradeModule(def.id, 10)
          if (!ok) { flashFail(b10); return }
          lastState = game.getSnapshot()
          render()
        }
        const bM = btn('+Max', 'btn')
        bM.onclick = () => {
          if (!game) return
          const ok = game.upgradeModule(def.id, 'max')
          if (!ok) { flashFail(bM); return }
          lastState = game.getSnapshot()
          render()
        }

        actions.append(add, kv('Level', String(level), true), b1, b10, bM)
      }

      cb.append(effect, actions)
      card.append(ch, cb)
      list.appendChild(card)
    }

    // Pagination controls
    const pager = el('div', 'hud-pager')
    const prevBtn = btn('◀ Prev', 'btn')
    prevBtn.onclick = () => { modulesPage = Math.max(0, modulesPage - 1); render() }
    if (modulesPage === 0) prevBtn.disabled = true

    const pageLabel = el('div', 'muted mono')
    pageLabel.textContent = `${modulesPage + 1} / ${totalPages}`
    pageLabel.style.fontSize = '13px'

    const nextBtn = btn('Next ▶', 'btn')
    nextBtn.onclick = () => { modulesPage = Math.min(totalPages - 1, modulesPage + 1); render() }
    if (modulesPage >= totalPages - 1) nextBtn.disabled = true

    pager.append(prevBtn, pageLabel, nextBtn)

    body.append(bal, slotsPanel, filterRow, list, pager)
    panel.append(header, body)
    center.appendChild(panel)
  }

  function moduleEffectText(def: GameConfig['modules']['defs'][number]): string {
    const parts: string[] = []
    const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`

    if (def.dmgMultPerLevel) parts.push(`Damage: ${pct(def.dmgMultPerLevel)} / level`)
    if (def.dmgFlatPerLevel) parts.push(`Flat Damage: ${def.dmgFlatPerLevel >= 0 ? '+' : ''}${def.dmgFlatPerLevel} / level`)
    if (def.fireRateBonusPerLevel) parts.push(`Fire Rate: ${pct(def.fireRateBonusPerLevel)} / level`)
    if (def.rangeBonusPerLevel) parts.push(`Range: ${def.rangeBonusPerLevel >= 0 ? '+' : ''}${def.rangeBonusPerLevel} / level`)
    if (def.armorPiercePerLevel) parts.push(`Armor Pierce: ${pct(def.armorPiercePerLevel)} / level`)
    if (def.baseHPBonusPerLevel) parts.push(`Base HP: ${def.baseHPBonusPerLevel >= 0 ? '+' : ''}${def.baseHPBonusPerLevel} / level`)
    if (def.baseHPMultPerLevel) parts.push(`Max HP Mult: ${pct(def.baseHPMultPerLevel)} / level`)
    if (def.goldMultPerLevel) parts.push(`Gold Mult: ${pct(def.goldMultPerLevel)} / level`)

    if (def.shotCountPerLevel) {
      const cap = typeof def.shotCountCap === 'number' ? ` (cap ${Math.max(1, Math.floor(def.shotCountCap))})` : ''
      parts.push(`Ability: Multi-shot (+${def.shotCountPerLevel} shots/level, floored)${cap}`)
    }
    if (def.invulnDurationSecPerLevel && def.invulnCooldownSec) {
      parts.push(`Ability: Invuln vs escapes (${def.invulnDurationSecPerLevel.toFixed(2)}s/level, every ${def.invulnCooldownSec}s)`)
    }

    if (def.critEveryN && def.critMultPerLevel) {
      parts.push(`Ability: Crit (every ${Math.max(2, Math.floor(def.critEveryN))} shots, +${pct(def.critMultPerLevel)} mult/level)`)
    }

    if (def.enemySpeedMultPerLevel) {
      parts.push(`Ability: Slow enemies (${pct(def.enemySpeedMultPerLevel)} speed/level)`)
    }
    if (typeof def.maxEffectiveLevel === 'number') parts.push(`Balance cap: effective Lv ≤ ${Math.max(0, Math.floor(def.maxEffectiveLevel))}`)

    return parts.length ? parts.join(' • ') : 'Effect: (not defined)'
  }

  function renderSettings() {
    if (!game || !lastState) return

    const panel = el('div', 'panel')
    panel.style.maxWidth = '820px'
    panel.style.margin = 'auto'
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Settings'

    const back = btn('Back', 'btn')
    back.onclick = () => setScreen('menu')
    header.appendChild(back)

    const body = el('div', 'panel-body')

    const audio = el('div')
    audio.innerHTML = `<div style="font-weight:800">Audio</div>`
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

    const nf = el('div')
    nf.style.marginTop = '12px'
    nf.innerHTML = `<div style="font-weight:800">Number Format</div>`

    const nfRow = el('div', 'stack')
    const suf = btn('Suffix', 'btn')
    const sci = btn('Scientific', 'btn')

    const markNF = () => {
      const active = lastState!.settings.numberFormat
      suf.classList.toggle('is-selected', active === 'suffix')
      sci.classList.toggle('is-selected', active === 'scientific')
      suf.setAttribute('aria-pressed', active === 'suffix' ? 'true' : 'false')
      sci.setAttribute('aria-pressed', active === 'scientific' ? 'true' : 'false')
    }
    markNF()

    suf.onclick = () => {
      lastState!.settings.numberFormat = 'suffix'
      game!.setSnapshot({ ...lastState! })
      markNF()
      render()
    }
    sci.onclick = () => {
      lastState!.settings.numberFormat = 'scientific'
      game!.setSnapshot({ ...lastState! })
      markNF()
      render()
    }
    nfRow.append(suf, sci)

    nf.appendChild(nfRow)

    body.append(audio, nf)
    panel.append(header, body)
    center.appendChild(panel)
  }

  function showUpgradesModal() {
    if (!lastState) return

    const modal = el('div', 'panel')
    modal.style.width = 'min(720px, calc(100vw - 20px))'
    modal.style.pointerEvents = 'auto'

    const h = el('div', 'panel-header')
    const title = el('div')
    title.textContent = 'Upgrades'
    const close = btn('Close', 'btn')
    const overlay = mountModal(modal)
    close.onclick = () => overlay.remove()
    h.append(title, close)

    const b = el('div', 'panel-body')
    b.appendChild(
      renderUpgradesTabs(() => {
        overlay.remove()
        showUpgradesModal()
      }),
    )

    if (upgradesTab === 'attack') {
      b.appendChild(renderUpgradeRow('Damage', 'damage', lastState.towerUpgrades.damageLevel))
      b.appendChild(renderUpgradeRow('Attack Speed', 'fireRate', lastState.towerUpgrades.fireRateLevel))
      b.appendChild(renderUpgradeRow('Crit', 'crit', lastState.towerUpgrades.critLevel))
      b.appendChild(renderUpgradeRow('Multi-shot', 'multiShot', lastState.towerUpgrades.multiShotLevel))
      b.appendChild(renderUpgradeRow('Armor Piercing', 'armorPierce', lastState.towerUpgrades.armorPierceLevel))
    } else if (upgradesTab === 'defense') {
      b.appendChild(renderUpgradeRow('Base HP', 'baseHP', lastState.towerUpgrades.baseHPLevel))
      b.appendChild(renderUpgradeRow('Slow Field', 'slow', lastState.towerUpgrades.slowLevel))
      b.appendChild(renderUpgradeRow('Fortify (Escape DR)', 'fortify', lastState.towerUpgrades.fortifyLevel))
      b.appendChild(renderUpgradeRow('Repair (Regen)', 'repair', lastState.towerUpgrades.repairLevel))
    } else {
      b.appendChild(renderUpgradeRow('Range', 'range', lastState.towerUpgrades.rangeLevel))
      b.appendChild(renderUpgradeRow('Gold Finder', 'gold', lastState.towerUpgrades.goldLevel))
    }

    modal.append(h, b)

    // Optional: click outside to close
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) overlay.remove()
    })
  }

  function renderStats() {
    if (!lastState) return

    const panel = el('div', 'panel')
    panel.style.maxWidth = '920px'
    panel.style.margin = 'auto'
    panel.style.pointerEvents = 'auto'

    const header = el('div', 'panel-header')
    header.appendChild(el('div')).textContent = 'Codex / Stats'

    const back = btn('Back', 'btn')
    back.onclick = () => setScreen('menu')
    header.appendChild(back)

    const body = el('div', 'panel-body')

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
      <div class="muted">Killed: <span class="mono">${report.killed}</span> • Escaped: <span class="mono">${report.escaped}</span></div>
      <div class="muted">KR: <span class="mono">${report.killRatio.toFixed(2)}</span> • Target: <span class="mono">${report.threshold.toFixed(2)}</span></div>
      <div class="muted">Reward: <span class="mono">${formatNumber(report.rewardGold, lastState?.settings.numberFormat ?? 'suffix')}</span> gold • <span class="mono">${formatPaladyum(report.rewardPoints)}</span> Paladyum</div>
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
    const ad = btn('Watch Ad for 2x (deterministic multiplier)', 'btn')

    collect.onclick = async () => {
      const g = game
      if (!g) return
      collect.disabled = true
      ad.disabled = true
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
        ad.disabled = false
      }
    }
    ad.onclick = () => {
      alert('No ads in this prototype; the multiplier is for demo purposes. We can add a real ad integration later.')
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
      <div class="muted">Ended at wave: <span class="mono">${summary.endedAtWave}</span></div>
      <div class="muted">Total gold: <span class="mono">${formatNumber(summary.totalGoldThisRun, lastState?.settings.numberFormat ?? 'suffix')}</span></div>
      <div class="muted">Time: <span class="mono">${formatTimeMMSS(summary.totalTimeSec)}</span></div>
    `

    const overlay = mountModal(modal)

    const row = el('div', 'stack')
    row.style.marginTop = '10px'

    const menu = btn('Menu', 'btn')
    menu.onclick = () => {
      overlay.remove()
      setScreen('menu')
    }

    const newRun = btn('New Run', 'btn btn-primary')
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
