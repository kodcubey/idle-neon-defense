import type { GameConfig, GameState, OfflineProgressResult } from '../types'
import {
  calcDPS,
  calcPenaltyFactor,
  calcThreshold,
  calcTotalEHP,
  clamp,
  calcBaseGold,
  calcPointsReward,
  aggregateModules,
} from './deterministic'

export function applyOfflineProgress(args: {
  state: GameState
  nowUTC: number
  config: GameConfig
  rewarded?: boolean
}): OfflineProgressResult {
  const { config, nowUTC } = args
  const stateBefore = { ...args.state }
  const state = { ...args.state }

  const elapsedSec = Math.max(0, (nowUTC - state.lastSaveTimestampUTC) / 1000)
  const T = config.sim.waveDurationSec
  const offlineWaves = Math.floor(elapsedSec / T)

  if (offlineWaves <= 0) {
    return {
      hasOffline: false,
      elapsedSec,
      offlineWaves: 0,
      estimatedKillRatioNoteTR: '—',
      gainedGold: 0,
      factorApplied: 0,
      stateBefore,
      stateAfter: state,
    }
  }

  const factorApplied = args.rewarded ? config.progression.rewardedOfflineFactor : config.progression.offlineFactor

  let gainedGold = 0
  let gainedPoints = 0

  // Deterministic estimate per-wave based on DPS vs totalEHP.
  // NOTE: Uses *wave start* snapshot estimation; labeled as "estimated" in UI.
  for (let k = 1; k <= offlineWaves; k++) {
    const w = state.wave + (k - 1)
    const dps = calcDPS(state, config)
    const totalEHP = calcTotalEHP(w, dps, config)

    const estimatedKillRatio = clamp(
      config.progression.offlineKillK0 + config.progression.offlineKillK1 * Math.log(1 + dps / Math.max(1, totalEHP)),
      0,
      1,
    )

    const threshold = calcThreshold(w, config)
    const { penaltyFactor } = calcPenaltyFactor(estimatedKillRatio, threshold, config)

    const baseGold = calcBaseGold(w, totalEHP, config)
    const goldMult = aggregateModules(state, config).goldMult
    gainedGold += baseGold * penaltyFactor * factorApplied * goldMult

    gainedPoints += calcPointsReward(w, config)
  }

  state.gold += gainedGold
  state.points += gainedPoints
  state.wave += offlineWaves
  state.lastSaveTimestampUTC = nowUTC

  return {
    hasOffline: true,
    elapsedSec,
    offlineWaves,
    estimatedKillRatioNoteTR: 'Çevrimdışı Öldürme Oranı tahminidir (deterministik).',
    gainedGold,
    factorApplied,
    stateBefore,
    stateAfter: state,
  }
}
