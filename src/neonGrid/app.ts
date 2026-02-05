import { defaultConfig } from './config/defaultConfig'
import { loadOrCreateSave, saveSnapshot } from './persistence/save'
import { createFirebaseSync } from './persistence/firebaseSync'
import { applyOfflineProgress } from './sim/offline'
import { createUIStateMachine } from './ui/uiStateMachine'
import { installDeterministicNoRng } from './noRng'

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

  const offlineResult = applyOfflineProgress({
    state: save.state,
    nowUTC,
    config,
  })

  const ui = createUIStateMachine({
    root: mount.uiRoot,
    config,
    initialState: offlineResult.hasOffline ? 'offline' : 'boot',
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
      void firebaseSync
        .uploadMetaFromState(game.getSnapshot())
        .catch(() => {
          // ignore
        })
    },
  })

  ui.bindGame(game)

  // Pause by default on first load. Gameplay starts when the user presses
  // Continue (unpause) or New Run (starts unpaused).
  game.setPaused(true)

  if (offlineResult.hasOffline) {
    game.setPaused(true)
    ui.showOffline(offlineResult)
  }

  // Persist on visibility changes; offline progress is computed on resume.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      const snapshot = game.getSnapshot()
      saveSnapshot(config, snapshot)
      return
    }

    // If the game is paused (e.g. menu/login/auth screens), do not
    // advance waves via offline progress. Just refresh the save timestamp.
    if (game.isPaused()) {
      const snapshot = game.getSnapshot()
      saveSnapshot(config, snapshot)
      return
    }

    const now = Date.now()
    const snapshot = game.getSnapshot()
    const result = applyOfflineProgress({ state: snapshot, nowUTC: now, config })
    if (result.hasOffline) {
      game.setPaused(true)
      ui.showOffline(result)
    }
  })
}
