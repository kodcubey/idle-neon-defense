import { defaultConfig } from './config/defaultConfig'
import { loadOrCreateSave, saveSnapshot } from './persistence/save'
import { createFirebaseSync } from './persistence/firebaseSync'
import { createUIStateMachine } from './ui/uiStateMachine'
import { installDeterministicNoRng } from './noRng'
import type { OfflineProgressResult } from './types'

export type NeonGridMount = {
  gameRoot: HTMLDivElement
  uiRoot: HTMLDivElement
}

export async function createNeonGridApp(mount: NeonGridMount) {
  const config = defaultConfig

  const firebaseSync = createFirebaseSync()

  // Enforce "RNG=0" at runtime by eliminating entropy.
  // (Some libraries may call JS randomness APIs during init; this keeps it deterministic.)
  installDeterministicNoRng()

  const nowUTC = Date.now()
  const save = loadOrCreateSave(config, nowUTC)

  // Offline progression is disabled: always start from the saved state
  // without simulating elapsed time while the player is away.
  save.state.lastSaveTimestampUTC = nowUTC
  saveSnapshot(config, save.state)

  const offlineResult: OfflineProgressResult = {
    hasOffline: false,
    elapsedSec: 0,
    offlineWaves: 0,
    estimatedKillRatioNoteTR: '—',
    gainedGold: 0,
    factorApplied: 0,
    stateAfter: save.state,
  }

  const ui = createUIStateMachine({
    root: mount.uiRoot,
    config,
    initialState: 'boot',
    offlineResult,
    firebaseSync,
  })

  const { createGame } = await import('./phaser/createGame')

  const game = createGame({
    parent: mount.gameRoot,
    config,
    initialState: save.state,
    onWaveComplete: (report) => ui.showWaveComplete(report),
    onStateChanged: (state) => {
      ui.setHUDState(state)
      saveSnapshot(config, state)
    },
    onGameOver: (runSummary) => {
      ui.showGameOver(runSummary)

      // Cloud sync: upload only when the run ends (game over).
      // Best-effort; errors can be handled via Settings actions.
      const st = firebaseSync.getStatus()
      const canCloud = st.configured && st.signedIn
      if (canCloud) {
        void firebaseSync
          .uploadMetaFromState(game.getSnapshot())
          .catch(() => {
            // ignore
          })
      }
    },
  })

  ui.bindGame(game)

  // Pause by default on first load. Gameplay starts when the user presses
  // Continue (unpause) or New Run (starts unpaused).
  game.setPaused(true)

  // Persist on visibility changes. Offline progression is disabled.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      const snapshot = game.getSnapshot()
      saveSnapshot(config, snapshot)
      return
    }

    // On resume, just refresh the save timestamp; no catch-up simulation.
    const snapshot = game.getSnapshot()
    saveSnapshot(config, snapshot)
  })
}
