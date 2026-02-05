export type NumberFormat = 'suffix' | 'scientific'
export type QualityMode = 'low' | 'med' | 'high'

export type Settings = {
  audioMaster: number // 0..1 (UI only; deterministic)
  quality: QualityMode
  numberFormat: NumberFormat
  reduceEffects: boolean
  language: 'tr' | 'en'
}

export type ModuleCategory = 'OFFENSE' | 'DEFENSE' | 'UTILITY'

export type ModuleDef = {
  id: string
  nameTR: string
  category: ModuleCategory
  iconConcept: string

  dmgMultPerLevel?: number
  dmgFlatPerLevel?: number
  fireRateBonusPerLevel?: number
  rangeBonusPerLevel?: number
  armorPiercePerLevel?: number
  baseHPBonusPerLevel?: number

  goldMultPerLevel?: number
}

export type EnemyTypeDef = {
  id: string
  nameTR: string
  color: string
  hpMult: number
  armorMult: number
  baseSpeed: number
}

export type GameConfig = {
  version: number
  ui: {
    palette: {
      bg: string
      panelRGBA: string
      neonCyan: string
      neonMagenta: string
      neonLime: string
      danger: string
      text: string
    }
    tipsTR: string[]
  }

  sim: {
    tickHz: number
    waveDurationSec: number
    timeScales: ReadonlyArray<1 | 2 | 3>
    autoOverlayCloseSec: number
  }

  progression: {
    clearFactorRho: number

    // DPS model
    d0: number
    dmgGrowthD: number
    r0: number
    rMax: number
    fireRateLogK: number

    prestigeMu: number

    // Difficulty G(w)
    a: number
    b: number
    c: number
    earlyEnd: number
    midEnd: number

    // Spawn
    nMin: number
    nMaxHigh: number
    nMaxMed: number
    nMaxLow: number
    u: number
    v: number
    spawnP: number

    // Patterning
    enemyTypeA: number
    enemyTypeB: number
    enemyTypeC: number

    patternP1: number
    patternP2: number
    patternCountP: number
    burstPatternValues: number[]
    burstTightness: number // 0..1

    // Enemy stat shaping
    typeVariationBeta: number
    typeVariationM: number
    armorMax: number
    armorAlpha: number
    speedK: number

    // Kill ratio threshold + penalty
    th0: number
    thSlope: number
    thMin: number
    thMax: number

    penK: number
    penMin: number

    // Rewards
    g0: number
    gamma: number
    goldWaveK: number
    p0: number
    pointsGrowthPer10: number

    // Escapes
    enableEscapeDamage: boolean
    escapeDamage: number
    deficitBoost: number

    // Offline
    offlineFactor: number
    rewardedOfflineFactor: number
    offlineKillK0: number
    offlineKillK1: number
  }

  tower: {
    baseRange: number
    rangeGrowth: number
    baseHP0: number
    baseHPGrowth: number
    armorPierce0: number
  }

  economy: {
    upgradeCostBase: number
    upgradeCostGrowth: number
    moduleUnlockPointCostBase: number
    moduleUnlockPointCostGrowth: number
    moduleUpgradeGoldBase: number
    moduleUpgradeGoldGrowth: number
  }

  enemies: {
    types: EnemyTypeDef[]
  }

  modules: {
    slotCount: number
    defs: ModuleDef[]
  }
}

export type Stats = {
  totalKills: number
  totalEscapes: number
  bestWave: number
  runsCount: number
  totalTimeSec: number
}

export type GameState = {
  version: number
  lastSaveTimestampUTC: number

  wave: number
  gold: number
  points: number

  baseHP: number
  towerUpgrades: {
    damageLevel: number
    fireRateLevel: number
    rangeLevel: number
    baseHPLevel: number
  }

  modulesUnlocked: Record<string, boolean>
  modulesEquipped: Record<number, string | null> // slot -> moduleId
  moduleLevels: Record<string, number>

  prestigePoints: number
  settings: Settings
  stats: Stats
}

export type WaveSnapshot = {
  wave: number
  dpsSnap: number
  totalEHP: number
  spawnCount: number
  threshold: number
}

export type WaveRuntime = {
  waveTimeSec: number
  spawnedSoFar: number
  killed: number
  escaped: number
}

export type WaveReport = {
  wave: number
  killed: number
  escaped: number
  killRatio: number
  threshold: number
  penaltyFactor: number
  rewardGold: number
  rewardPoints: number
  baseDamageFromEscapes: number
  dpsSnap: number
  totalEHP: number
}

export type OfflineProgressResult = {
  hasOffline: boolean
  elapsedSec: number
  offlineWaves: number
  estimatedKillRatioNoteTR: string
  gainedGold: number
  factorApplied: number
  stateBefore?: GameState
  stateAfter: GameState
}

export type RunSummary = {
  endedAtWave: number
  totalGoldThisRun: number
  totalTimeSec: number
}
