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
      'Modules are unlocked by choice; there are no drop rates.',
      'Lowering quality limits enemy count on mobile.',
      'Prestige: reset + permanent multiplier (deterministic).',
    ],
  },

  sim: {
    tickHz: 60,
    waveDurationSec: 30.0,
    timeScales: [1, 2, 3],
    autoOverlayCloseSec: 1.6,
  },

  progression: {
    clearFactorRho: 0.78,

    d0: 8,
    dmgGrowthD: 0.095,
    r0: 1.1,
    rMax: 8.0,
    fireRateLogK: 0.55,

    prestigeMu: 0.06,

    a: 0.042,
    b: 0.028,
    c: 0.018,
    earlyEnd: 50,
    midEnd: 200,

    nMin: 10,
    nMaxHigh: 90,
    nMaxMed: 70,
    nMaxLow: 50,
    u: 1.9,
    v: 2.2,
    spawnP: 1.3,

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
    speedK: 0.9,

    th0: 0.62,
    thSlope: 0.06,
    thMin: 0.62,
    thMax: 0.92,

    penK: 0.9,
    penMin: 0.4,

    g0: 0.55,
    gamma: 0.72,
    goldWaveK: 0.18,
    p0: 1,
    pointsGrowthPer10: 1.28,

    enableEscapeDamage: true,
    escapeDamage: 2.0,
    deficitBoost: 1.6,

    offlineFactor: 0.6,
    rewardedOfflineFactor: 1.2,
    offlineKillK0: 0.22,
    offlineKillK1: 0.75,
  },

  tower: {
    baseRange: 200,
    rangeGrowth: 4.0,
    baseHP0: 130,
    baseHPGrowth: 0.08,
    armorPierce0: 0.0,
  },

  economy: {
    upgradeCostBase: 10,
    upgradeCostGrowth: 1.13,
    moduleUnlockPointCostBase: 2,
    moduleUnlockPointCostGrowth: 1.22,
    moduleUpgradeGoldBase: 25,
    moduleUpgradeGoldGrowth: 1.16,
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

  modules: {
    slotCount: 6,
    defs: [
      { id: 'MX_FLUX', nameTR: 'Flux Multiplier', category: 'OFFENSE', iconConcept: 'double ring + arrows', dmgMultPerLevel: 0.06 },
      { id: 'MX_SPARK', nameTR: 'Spark Conductor', category: 'OFFENSE', iconConcept: 'neon lightning trails', dmgFlatPerLevel: 2.4 },
      { id: 'MX_PRISM', nameTR: 'Prism Focus', category: 'OFFENSE', iconConcept: 'triangular prism + beam', dmgMultPerLevel: 0.04, fireRateBonusPerLevel: 0.04 },
      { id: 'MX_OVERCLK', nameTR: 'Overclock', category: 'OFFENSE', iconConcept: 'clock dial + speed streak', fireRateBonusPerLevel: 0.08 },
      { id: 'MX_LENS', nameTR: 'Lens Array', category: 'OFFENSE', iconConcept: 'hex lens honeycomb', rangeBonusPerLevel: 6.0 },
      { id: 'MX_PIERCE', nameTR: 'Armor Piercer', category: 'OFFENSE', iconConcept: 'piercing arrowhead', armorPiercePerLevel: 0.04 },

      { id: 'DF_BULWARK', nameTR: 'Bulwark Protocol', category: 'DEFENSE', iconConcept: 'shield + grid', baseHPBonusPerLevel: 8.0 },
      { id: 'DF_REGEN', nameTR: 'Repair Nanofiber', category: 'DEFENSE', iconConcept: 'stitch line + wave', baseHPBonusPerLevel: 5.0 },
      { id: 'DF_SHELL', nameTR: 'Glass Armor', category: 'DEFENSE', iconConcept: 'glass dome', baseHPBonusPerLevel: 10.0 },

      { id: 'UT_MINT', nameTR: 'Micro Mint', category: 'UTILITY', iconConcept: 'microchip + coin', goldMultPerLevel: 0.03 },
      { id: 'UT_LOG', nameTR: 'Telemetry Log', category: 'UTILITY', iconConcept: 'chart line', goldMultPerLevel: 0.02 },
      { id: 'UT_CALIB', nameTR: 'Calibration Ring', category: 'UTILITY', iconConcept: 'rings + marker', dmgMultPerLevel: 0.02, goldMultPerLevel: 0.01 },

      { id: 'MX_GAUSS', nameTR: 'Gauss Sled', category: 'OFFENSE', iconConcept: 'rail + particles', dmgMultPerLevel: 0.05 },
      { id: 'MX_NODE', nameTR: 'Neural Node', category: 'UTILITY', iconConcept: 'connected nodes', fireRateBonusPerLevel: 0.03, goldMultPerLevel: 0.015 },
      { id: 'DF_COOLANT', nameTR: 'Coolant Line', category: 'DEFENSE', iconConcept: 'pipe + snowflake', baseHPBonusPerLevel: 6.0 },

      { id: 'MX_VECTOR', nameTR: 'Vector Curve', category: 'OFFENSE', iconConcept: 'curved arrow', dmgFlatPerLevel: 1.7, fireRateBonusPerLevel: 0.03 },
      { id: 'MX_QUANTA', nameTR: 'Quantum Trace', category: 'OFFENSE', iconConcept: 'two trails + phase shift', dmgMultPerLevel: 0.03, armorPiercePerLevel: 0.02 },
      { id: 'UT_ROUTER', nameTR: 'Signal Router', category: 'UTILITY', iconConcept: 'direction arrows', rangeBonusPerLevel: 3.0, goldMultPerLevel: 0.015 },

      // The remaining defs are data-only for the UI/Codex; effects can be added later without RNG.
      { id: 'MX_ARC', nameTR: 'Arc Index', category: 'OFFENSE', iconConcept: 'arc line', dmgMultPerLevel: 0.02 },
      { id: 'MX_CHORD', nameTR: 'Chord Resonance', category: 'OFFENSE', iconConcept: 'waveform', dmgFlatPerLevel: 1.2 },
      { id: 'MX_SPECTR', nameTR: 'Spectrum Tuning', category: 'OFFENSE', iconConcept: 'color bands', fireRateBonusPerLevel: 0.02 },
      { id: 'DF_ANCHOR', nameTR: 'Anchor Field', category: 'DEFENSE', iconConcept: 'anchor icon', baseHPBonusPerLevel: 4.0 },
      { id: 'DF_LOCK', nameTR: 'Lock Cell', category: 'DEFENSE', iconConcept: 'lock', baseHPBonusPerLevel: 3.5 },
      { id: 'UT_INDEX', nameTR: 'Indexer', category: 'UTILITY', iconConcept: 'tag', goldMultPerLevel: 0.01 },

      { id: 'MX_DELTA', nameTR: 'Delta Thrust', category: 'OFFENSE', iconConcept: 'Δ symbol', dmgMultPerLevel: 0.02 },
      { id: 'MX_FOCUS', nameTR: 'Focal Point', category: 'OFFENSE', iconConcept: 'crosshair', dmgFlatPerLevel: 1.0 },
      { id: 'UT_BUFFER', nameTR: 'Buffer', category: 'UTILITY', iconConcept: 'stacked boxes', goldMultPerLevel: 0.012 },
      { id: 'DF_GRID', nameTR: 'Shield Grid', category: 'DEFENSE', iconConcept: 'grid', baseHPBonusPerLevel: 4.5 },

      { id: 'MX_TACH', nameTR: 'Tachyon Strike', category: 'OFFENSE', iconConcept: 'speed arrow', fireRateBonusPerLevel: 0.02 },
      { id: 'MX_GLYPH', nameTR: 'Glyph Cut', category: 'OFFENSE', iconConcept: 'rune-like glyph', dmgMultPerLevel: 0.015 },
      { id: 'UT_LEDGER', nameTR: 'Cyber Ledger', category: 'UTILITY', iconConcept: 'ledger', goldMultPerLevel: 0.01 },
      { id: 'DF_VAULT', nameTR: 'Vault Case', category: 'DEFENSE', iconConcept: 'safe', baseHPBonusPerLevel: 5.0 },

      { id: 'MX_PHASE', nameTR: 'Phase Shear', category: 'OFFENSE', iconConcept: 'phase ring', armorPiercePerLevel: 0.015 },
      { id: 'UT_CLOCK', nameTR: 'Timestamp', category: 'UTILITY', iconConcept: 'clock', goldMultPerLevel: 0.012 },
      { id: 'DF_CORE', nameTR: 'Core Safeguard', category: 'DEFENSE', iconConcept: 'core', baseHPBonusPerLevel: 6.5 },

      { id: 'MX_HEX', nameTR: 'Hex Lattice', category: 'OFFENSE', iconConcept: 'hex lattice', dmgMultPerLevel: 0.012 },
      { id: 'UT_MAP', nameTR: 'Path Map', category: 'UTILITY', iconConcept: 'map', rangeBonusPerLevel: 2.0 },
      { id: 'MX_BEAM', nameTR: 'Beam Constrictor', category: 'OFFENSE', iconConcept: 'thin beam', dmgFlatPerLevel: 0.8 },

      { id: 'DF_SEAL', nameTR: 'Sealing', category: 'DEFENSE', iconConcept: 'seal', baseHPBonusPerLevel: 3.0 },
      { id: 'UT_LINK', nameTR: 'Link Protocol', category: 'UTILITY', iconConcept: 'chain', goldMultPerLevel: 0.01 },
      { id: 'MX_ORBIT', nameTR: 'Orbit Notch', category: 'OFFENSE', iconConcept: 'orbit', fireRateBonusPerLevel: 0.015 },

      { id: 'MX_RAIL', nameTR: 'Rail Signature', category: 'OFFENSE', iconConcept: 'parallel lines', dmgMultPerLevel: 0.015 },
      { id: 'DF_FUSE', nameTR: 'Fuse Bank', category: 'DEFENSE', iconConcept: 'fuse', baseHPBonusPerLevel: 2.5 },
      { id: 'UT_ARCHIVE', nameTR: 'Archive Mode', category: 'UTILITY', iconConcept: 'archive box', goldMultPerLevel: 0.008 },

      { id: 'MX_PULSE', nameTR: 'Pulse Array', category: 'OFFENSE', iconConcept: 'pulse', dmgFlatPerLevel: 0.9 },
      { id: 'DF_SPINE', nameTR: 'Spine Frame', category: 'DEFENSE', iconConcept: 'spine', baseHPBonusPerLevel: 3.5 },
      { id: 'UT_AUDIT', nameTR: 'Audit Log', category: 'UTILITY', iconConcept: 'check', goldMultPerLevel: 0.01 },
    ],
  },
}
