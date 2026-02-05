import Phaser from 'phaser'
import type { GameConfig, GameState, RunSummary, WaveReport } from '../types'
import { SimEngine, type SimCallbacks, type SimPublic } from '../sim/SimEngine'
import { createNewState } from '../persistence/save'
import { applyTowerUpgrade, equipModule, tryModuleUnlock, tryModuleUpgrade } from '../sim/actions'
import { BootScene } from './scenes/BootScene'
import { GameScene } from './scenes/GameScene'

export type NeonGridGame = {
  getSnapshot: () => GameState
  setSnapshot: (s: GameState) => void
  setPaused: (p: boolean) => void
  setTimeScale: (s: 1 | 2 | 4) => void
  toggleAuto: () => void

  newRun: () => void

  buyUpgrade: (key: 'damage' | 'fireRate' | 'range' | 'baseHP', amount: 1 | 10 | 'max') => boolean

  unlockModule: (id: string) => boolean
  upgradeModule: (id: string, amount: 1 | 10 | 'max') => boolean
  equipModule: (slot: number, id: string | null) => boolean

  prestigeReset: () => { ok: boolean; gained: number }

  onSim: (cb: (pub: SimPublic) => void) => void
}

export function createGame(args: {
  parent: HTMLElement
  config: GameConfig
  initialState: GameState
  onWaveComplete: (r: WaveReport) => void
  onStateChanged: (s: GameState) => void
  onGameOver: (s: RunSummary) => void
}): NeonGridGame {
  const cfg = args.config

  let simListener: ((pub: SimPublic) => void) | null = null

  // Phaser scenes create the SimEngine asynchronously (in Scene.create()).
  // UI can call into this API immediately, so we keep a pending snapshot and settings
  // and apply them once the engine is ready.
  let pendingSnapshot: GameState = { ...args.initialState }
  let pendingPaused: boolean | null = null
  let pendingTimeScale: 1 | 2 | 4 | null = null
  let pendingToggleAutoCount = 0

  const callbacks = {
    onWaveComplete: args.onWaveComplete,
    onStateChanged: args.onStateChanged,
    onGameOver: args.onGameOver,
  } satisfies SimCallbacks

  const phaserConfig: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: args.parent,
    backgroundColor: cfg.ui.palette.bg,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    fps: {
      target: 60,
      forceSetTimeOut: true,
    },
    scene: [BootScene, GameScene],
  }

  const game = new Phaser.Game(phaserConfig)

  // Canvas pointer-events are disabled (DOM UI overlay). Many browsers require a user gesture
  // to unlock/resume audio; use a DOM listener so music can start.
  document.addEventListener(
    'pointerdown',
    () => {
      try {
        const anySound = (game as any).sound
        const ctx: AudioContext | undefined = anySound?.context
        if (ctx && ctx.state === 'suspended') void ctx.resume()
      } catch {
        // ignore
      }
    },
    { once: true, capture: true },
  )

  // Bridge from scenes -> engine
  let engine: SimEngine | null = null

  const initBridge = {
    cfg,
    initialState: pendingSnapshot,
    callbacks,
    onEngineReady: (e: SimEngine) => {
      engine = e

      // Ensure engine starts with the latest pending snapshot.
      e.setSnapshot(pendingSnapshot)

      if (pendingPaused !== null) e.setPaused(pendingPaused)
      if (pendingTimeScale !== null) e.setTimeScale(pendingTimeScale)
      while (pendingToggleAutoCount > 0) {
        e.toggleAuto()
        pendingToggleAutoCount--
      }
    },
    onSimPublic: (pub: SimPublic) => {
      if (simListener) simListener(pub)
    },
  }

  game.registry.set('neonGrid.init', initBridge)

  function syncPendingToBridge() {
    // Keep bridge initialState in sync in case the Scene isn't created yet.
    initBridge.initialState = pendingSnapshot
  }

  function currentState(): GameState {
    return engine ? engine.getSnapshot() : pendingSnapshot
  }

  function applyState(next: GameState) {
    pendingSnapshot = { ...next }
    syncPendingToBridge()
    if (engine) engine.setSnapshot(pendingSnapshot)

    // Sync audio master volume (UI setting).
    try {
      if ((game as any).sound) (game as any).sound.volume = Math.max(0, Math.min(1, pendingSnapshot.settings.audioMaster))
    } catch {
      // ignore
    }
  }

  return {
    getSnapshot: () => currentState(),
    setSnapshot: (s) => applyState(s),
    setPaused: (p) => {
      pendingPaused = p
      if (engine) engine.setPaused(p)
    },
    setTimeScale: (s) => {
      pendingTimeScale = s
      if (engine) engine.setTimeScale(s)
    },
    toggleAuto: () => {
      if (engine) engine.toggleAuto()
      else pendingToggleAutoCount++
    },

    newRun: () => {
      const prev = currentState()
      const s = createNewState(cfg, Date.now())
      s.stats.runsCount = (prev.stats.runsCount ?? 0) + 1
      applyState(s)
      pendingPaused = false
      if (engine) engine.setPaused(false)
    },

    buyUpgrade: (key, amount) => {
      const s = currentState()
      const next = applyTowerUpgrade({ state: s, cfg, key, amount })
      if (!next.ok) return false
      applyState(next.state)
      return true
    },

    unlockModule: (id) => {
      const s = currentState()
      const next = tryModuleUnlock({ state: s, cfg, id })
      if (!next.ok) return false
      applyState(next.state)
      return true
    },

    upgradeModule: (id, amount) => {
      const s = currentState()
      const next = tryModuleUpgrade({ state: s, cfg, id, amount })
      if (!next.ok) return false
      applyState(next.state)
      return true
    },

    equipModule: (slot, id) => {
      const s = currentState()
      const next = equipModule({ state: s, cfg, slot, id })
      if (!next.ok) return false
      applyState(next.state)
      return true
    },

    prestigeReset: () => {
      const s = currentState()
      const gained = Math.max(0, Math.floor(Math.pow(Math.max(0, s.stats.bestWave - 1), 0.62) / 8))
      if (gained <= 0) return { ok: false, gained: 0 }

      const next = createNewState(cfg, Date.now())
      next.prestigePoints = s.prestigePoints + gained
      next.stats.runsCount = (s.stats.runsCount ?? 0) + 1
      next.stats.bestWave = Math.max(next.stats.bestWave, 1)
      applyState(next)
      pendingPaused = false
      if (engine) engine.setPaused(false)
      return { ok: true, gained }
    },

    onSim: (cb) => {
      simListener = cb
    },
  }
}
