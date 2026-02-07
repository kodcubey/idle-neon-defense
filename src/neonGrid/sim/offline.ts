import type { GameConfig, GameState, OfflineProgressResult } from '../types'

export function applyOfflineProgress(args: {
  state: GameState
  nowUTC: number
  config: GameConfig
}): OfflineProgressResult {
  const { nowUTC } = args
  const stateBefore = { ...args.state }
  const stateAfter = { ...args.state, lastSaveTimestampUTC: nowUTC }

  // Offline progression intentionally disabled.
  return {
    hasOffline: false,
    elapsedSec: 0,
    offlineWaves: 0,
    estimatedKillRatioNoteTR: '—',
    gainedGold: 0,
    factorApplied: 0,
    stateBefore,
    stateAfter,
  }
}
