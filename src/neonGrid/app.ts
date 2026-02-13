import { defaultConfig } from './config/defaultConfig'
import { loadOrCreateSave, saveSnapshot } from './persistence/save'
import { createUIStateMachine } from './ui/uiStateMachine'
import { installDeterministicNoRng } from './noRng'
import type { OfflineProgressResult } from './types'

export type NeonGridMount = {
  gameRoot: HTMLDivElement
  uiRoot: HTMLDivElement
}

export async function createNeonGridApp(mount: NeonGridMount) {
  const config = defaultConfig

  // Enforce "RNG=0" at runtime by eliminating entropy.
  // (Some libraries may call JS randomness APIs during init; this keeps it deterministic.)
  installDeterministicNoRng()

  const nowUTC = Date.now()
  const initialState = await loadOrCreateSave(config, nowUTC)

  const offlineResult: OfflineProgressResult = {
    hasOffline: false,
    elapsedSec: 0,
    offlineWaves: 0,
    estimatedKillRatioNoteTR: '—',
    gainedGold: 0,
    factorApplied: 0,
    stateAfter: initialState,
  }

  const ui = createUIStateMachine({
    root: mount.uiRoot,
    config,
    initialState: 'boot',
    offlineResult,
  })

  const { createGame } = await import('./phaser/createGame')

  const game = createGame({
    parent: mount.gameRoot,
    config,
    initialState,
    onWaveComplete: (report) => ui.showWaveComplete(report),
    onStateChanged: (state) => {
      ui.setHUDState(state)
      saveSnapshot(config, state)
    },
    onGameOver: (runSummary) => {
      ui.showGameOver(runSummary)
    },
  })

  ui.bindGame(game)

  // Pause by default on first load. Gameplay starts when the user presses
  // Continue (unpause) or New Run (starts unpaused).
  game.setPaused(true)
}
