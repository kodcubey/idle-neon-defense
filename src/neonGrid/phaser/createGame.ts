import Phaser from 'phaser'
import type { GameConfig, GameState, RunSummary, WaveReport } from '../types'
import { SimEngine, type SimCallbacks, type SimPublic } from '../sim/SimEngine'
import { createNewState } from '../persistence/save'
import { applyTowerUpgrade, equipModule, tryModuleUnlock, tryModuleUpgrade } from '../sim/actions'
import { BootScene } from './scenes/BootScene'
import { GameScene } from './scenes/GameScene'

export type NeonGridGame = {
  getSnapshot: () => GameState
  setSnapshot: (s: GameState, mode?: 'soft' | 'hard') => void
  setPaused: (p: boolean) => void
  isPaused: () => boolean
  setTimeScale: (s: 1 | 2 | 3) => void

  continueNextWave: () => void

  newRun: () => void

  buyUpgrade: (key: 'damage' | 'fireRate' | 'armorPierce' | 'baseHP' | 'fortify' | 'repair' | 'range' | 'gold', amount: 1 | 10 | 'max') => boolean

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
  let pendingTimeScale: 1 | 2 | 3 | null = null

  let lastPaused: boolean | null = null

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

  function currentPaused(): boolean {
    if (engine) return engine.isPaused()
    return pendingPaused ?? false
  }

  function applyState(next: GameState, mode: 'soft' | 'hard' = 'soft') {
    pendingSnapshot = { ...next }
    // Quality is fixed to HIGH.
    pendingSnapshot.settings = { ...pendingSnapshot.settings, quality: 'high' }
    syncPendingToBridge()

    if (engine) {
      if (mode === 'hard') engine.setSnapshot(pendingSnapshot)
      else engine.applyStateSoft(pendingSnapshot)
    }

    // Sync audio master volume (UI setting).
    try {
      if ((game as any).sound) (game as any).sound.volume = Math.max(0, Math.min(1, pendingSnapshot.settings.audioMaster))
    } catch {
      // ignore
    }
  }

  return {
    getSnapshot: () => currentState(),
    setSnapshot: (s, mode) => applyState(s, mode ?? 'soft'),
    setPaused: (p) => {
      const prev = currentPaused()
      pendingPaused = p
      if (engine) engine.setPaused(p)

      // UI calls setPaused(true) frequently while on menu/login.
      // Only trigger a save-worthy state notification on an actual
      // transition into paused=true.
      const nowPaused = p
      if (nowPaused !== lastPaused) {
        lastPaused = nowPaused
        if (!prev && nowPaused) callbacks.onStateChanged(currentState())
      }
    },
    isPaused: () => currentPaused(),
    setTimeScale: (s) => {
      pendingTimeScale = s
      if (engine) engine.setTimeScale(s)
    },

    continueNextWave: () => {
      if (engine) engine.startNextWave()
    },

    newRun: () => {
      const prev = currentState()
      const s = createNewState(cfg, Date.now())
      s.stats.runsCount = (prev.stats.runsCount ?? 0) + 1

      // Meta / persistent fields across runs.
      s.points = prev.points
      s.prestigePoints = prev.prestigePoints
      s.settings = { ...prev.settings }

      applyState(s, 'hard')
      pendingPaused = false
      if (engine) engine.setPaused(false)
    },

    buyUpgrade: (key, amount) => {
      const s = currentState()
      const next = applyTowerUpgrade({ state: s, cfg, key, amount })
      if (!next.ok) return false
      applyState(next.state, 'soft')
      return true
    },

    unlockModule: (id) => {
      const s = currentState()
      const next = tryModuleUnlock({ state: s, cfg, id })
      if (!next.ok) return false
      applyState(next.state, 'soft')
      return true
    },

    upgradeModule: (id, amount) => {
      const s = currentState()
      const next = tryModuleUpgrade({ state: s, cfg, id, amount })
      if (!next.ok) return false
      applyState(next.state, 'soft')
      return true
    },

    equipModule: (slot, id) => {
      const s = currentState()
      const next = equipModule({ state: s, cfg, slot, id })
      if (!next.ok) return false
      applyState(next.state, 'soft')
      return true
    },

    prestigeReset: () => {
      const s = currentState()
      const gained = Math.max(0, Math.floor(Math.pow(Math.max(0, s.stats.bestWave - 1), 0.62) / 8))
      if (gained <= 0) return { ok: false, gained: 0 }

      const next = createNewState(cfg, Date.now())
      next.prestigePoints = s.prestigePoints + gained

      // Keep Paladyum permanent across prestige.
      next.points = s.points
      next.settings = { ...s.settings }

      next.stats.runsCount = (s.stats.runsCount ?? 0) + 1
      next.stats.bestWave = Math.max(next.stats.bestWave, 1)
      applyState(next, 'hard')
      pendingPaused = false
      if (engine) engine.setPaused(false)
      return { ok: true, gained }
    },

    onSim: (cb) => {
      simListener = cb
    },
  }
}
