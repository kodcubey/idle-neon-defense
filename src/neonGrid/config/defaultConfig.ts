import type { GameConfig } from '../types'

export const defaultConfig: GameConfig = {
  version: 1,
  ui: {
    palette: {
      bg: '#070812',
      panelRGBA: 'rgba(14,18,38,0.72)',
      neonCyan: '#22F5FF',
      neonMagenta: '#FF2BD6',
      neonLime: '#B6FF2E',
      danger: '#FF3B3B',
      text: '#EAF0FF',
    },
    tipsTR: [
      'No randomness: the same inputs produce the same outputs.',
      'Wave duration is fixed; your success is determined by Kill Ratio.',
      'The penalty affects rewards/damage, not time.',
      'Lowering quality limits enemy count on mobile.',
    ],
  },

  sim: {
    tickHz: 60,
    waveDurationSec: 30.0,
    timeScales: [1, 2, 3],
    autoOverlayCloseSec: 1.6,
  },

  progression: {
    clearFactorRho: 0.72,

    d0: 8,
    dmgGrowthD: 0.078,
    r0: 1.05,
    rMax: 7.0,
    fireRateLogK: 0.45,

    prestigeMu: 0.06,

    a: 0.042,
    b: 0.028,
    c: 0.018,
    earlyEnd: 50,
    midEnd: 200,

    nMin: 8,
    nMaxHigh: 90,
    nMaxMed: 70,
    nMaxLow: 50,
    u: 1.4,
    v: 1.7,
    spawnP: 1.25,

    enemyTypeA: 17,
    enemyTypeB: 29,
    enemyTypeC: 7,

    patternP1: 9,
    patternP2: 4,
    patternCountP: 12,
    burstPatternValues: [3, 7, 10],
    burstTightness: 0.3,

    typeVariationBeta: 0.28,
    typeVariationM: 9,
    armorMax: 0.75,
    armorAlpha: 0.12,
    speedK: 0.6,

    th0: 0.56,
    thSlope: 0.055,
    thMin: 0.56,
    thMax: 0.92,

    penK: 0.95,
    penMin: 0.5,

    g0: 0.5,
    gamma: 0.68,
    goldWaveK: 0.16,
    // Paladyum baseline per-wave reward (tiered by 10 waves).
    // Tuned up to keep early-game motivation (17 Şubat 2026).
    p0: 7.5,
    pointsGrowthPer10: 1.22,
    paladyumDropRate: 0.03,

    enableEscapeDamage: true,
    escapeDamage: 1.4,
    deficitBoost: 1.2,

    offlineFactor: 0.6,
    offlineKillK0: 0.22,
    offlineKillK1: 0.75,
    
    // Skills
    // XP per wave scales with a controlled wave multiplier:
    //   mult = 1 + (k*(w-1)) / (1 + s*(w-1))
    skills: {
      baseXP: 22,
      waveXpK: 0.165,
      waveXpS: 0.1,
    },
  },

  tower: {
    baseRange: 200,
    rangeGrowth: 4.0,
    baseHP0: 170,
    baseHPGrowth: 0.08,
    armorPierce0: 0.0,

    upgrades: {
      maxLevels: {
        damage: 250,
        fireRate: 160,
        crit: 80,
        multiShot: 4,
        armorPierce: 60,
        baseHP: 220,
        slow: 60,
        fortify: 80,
        repair: 80,
        range: 20,
        gold: 120,
      },

      costMult: {
        // Attack
        damage: 1.0,
        fireRate: 1.15,
        crit: 1.3,
        multiShot: 2.0,
        armorPierce: 1.35,

        // Defense
        baseHP: 1.05,
        slow: 1.25,
        fortify: 1.45,
        repair: 1.55,

        // Utility
        range: 1.1,
        gold: 1.25,
      },

      armorPiercePerLevel: 0.006,

      // Escape damage multiplier = clamp(1 - (L-1)*fortifyPerLevel, fortifyMinMult, 1)
      fortifyPerLevel: 0.007,
      fortifyMinMult: 0.55,

      // Base regen per second: missingHP * clamp((L-1)*repairPctPerSecPerLevel, 0, repairMaxPctPerSec)
      repairPctPerSecPerLevel: 0.00035,
      repairMaxPctPerSec: 0.012,

      goldMultPerLevel: 0.012,

      // Crit (deterministic): at level 1 => disabled; effects scale with (L-1).
      // everyN = clamp(base - (L-1)*reduce, min, base)
      // mult  = 1 + (L-1)*critMultPerLevel
      critEveryNBase: 12,
      critEveryNMin: 4,
      critEveryNReducePerLevel: 0.08,
      critMultPerLevel: 0.04,

      // Slow: enemy speed multiplier = clamp(1 - (L-1)*slowPerLevel, slowMinMult, 1)
      slowPerLevel: 0.006,
      slowMinMult: 0.7,
    },
  },

  economy: {
    upgradeCostBase: 12,
    upgradeCostGrowth: 1.17,

    // Permanent upgrades (Paladyum / points)
    metaUpgradeCostBasePoints: 55,
    metaUpgradeCostGrowth: 1.23,

    moduleUnlockPointCostBase: 22,
    moduleUnlockPointCostGrowth: 1.45,
    moduleUpgradeGoldBase: 65,
    moduleUpgradeGoldGrowth: 1.25,

    moduleSlotUnlockPointCostBase: 140,
    moduleSlotUnlockPointCostGrowth: 2.05,
  },

  enemies: {
    types: [
      { id: 'V1', nameTR: 'Vector', color: '#22F5FF', hpMult: 1.0, armorMult: 1.0, baseSpeed: 58 },
      { id: 'PR', nameTR: 'Prism', color: '#FF2BD6', hpMult: 1.25, armorMult: 1.1, baseSpeed: 52 },
      { id: 'IO', nameTR: 'Ion', color: '#B6FF2E', hpMult: 0.85, armorMult: 0.9, baseSpeed: 68 },
      { id: 'NX', nameTR: 'Nexus', color: '#EAF0FF', hpMult: 1.6, armorMult: 1.25, baseSpeed: 46 },
      { id: 'CR', nameTR: 'Chrome', color: '#7A7CFF', hpMult: 1.05, armorMult: 1.55, baseSpeed: 50 },
      { id: 'PH', nameTR: 'Phase', color: '#FFB000', hpMult: 0.95, armorMult: 0.85, baseSpeed: 74 },
    ],
  },

  // Modules feature removed/disabled.
  modules: {
    slotCount: 1,
    levelExponent: 0.82,
    defs: [],
  },
}
