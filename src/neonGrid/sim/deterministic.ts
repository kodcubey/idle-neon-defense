import type { EnemyTypeDef, GameConfig, GameState, ModuleDef, WaveReport, WaveSnapshot } from '../types'

export function dayIndexUTC(nowUTC: number): number {
  return Math.floor(nowUTC / 86400_000)
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export function calcPrestigeMult(prestigePoints: number, cfg: GameConfig): number {
  return 1 + cfg.progression.prestigeMu * Math.sqrt(Math.max(0, prestigePoints))
}

export function baseDmg(damageLevel: number, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor(damageLevel))
  return cfg.progression.d0 * Math.pow(1 + cfg.progression.dmgGrowthD, L - 1)
}

export function fireRate(fireRateLevel: number, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor(fireRateLevel))
  const rate = cfg.progression.r0 + cfg.progression.fireRateLogK * Math.log(1 + L)
  return Math.min(cfg.progression.rMax, rate)
}

export function towerRange(rangeLevel: number, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor(rangeLevel))
  return cfg.tower.baseRange + cfg.tower.rangeGrowth * (L - 1)
}

export type ModuleAggregate = {
  dmgMult: number
  dmgFlat: number
  fireRateBonus: number
  rangeBonus: number
  armorPierce: number
  baseHPBonus: number
  goldMult: number
}

export function aggregateModules(state: GameState, cfg: GameConfig): ModuleAggregate {
  const defsById = new Map<string, ModuleDef>()
  for (const d of cfg.modules.defs) defsById.set(d.id, d)

  let dmgMult = 1
  let dmgFlat = 0
  let fireRateBonus = 0
  let rangeBonus = 0
  let armorPierce = cfg.tower.armorPierce0
  let baseHPBonus = 0
  let goldMult = 1

  for (let slot = 1; slot <= cfg.modules.slotCount; slot++) {
    const id = state.modulesEquipped[slot]
    if (!id) continue
    if (!state.modulesUnlocked[id]) continue

    const def = defsById.get(id)
    if (!def) continue

    const level = Math.max(0, Math.floor(state.moduleLevels[id] ?? 0))
    if (level <= 0) continue

    if (def.dmgMultPerLevel) dmgMult *= 1 + def.dmgMultPerLevel * level
    if (def.dmgFlatPerLevel) dmgFlat += def.dmgFlatPerLevel * level
    if (def.fireRateBonusPerLevel) fireRateBonus += def.fireRateBonusPerLevel * level
    if (def.rangeBonusPerLevel) rangeBonus += def.rangeBonusPerLevel * level
    if (def.armorPiercePerLevel) armorPierce += def.armorPiercePerLevel * level
    if (def.baseHPBonusPerLevel) baseHPBonus += def.baseHPBonusPerLevel * level
    if (def.goldMultPerLevel) goldMult *= 1 + def.goldMultPerLevel * level
  }

  return {
    dmgMult,
    dmgFlat,
    fireRateBonus,
    rangeBonus,
    armorPierce: clamp(armorPierce, 0, 0.9),
    baseHPBonus,
    goldMult,
  }
}

export function calcDPS(state: GameState, cfg: GameConfig): number {
  const mods = aggregateModules(state, cfg)
  const dmg =
    (baseDmg(state.towerUpgrades.damageLevel, cfg) * mods.dmgMult + mods.dmgFlat) *
    calcPrestigeMult(state.prestigePoints, cfg)
  const rate = fireRate(state.towerUpgrades.fireRateLevel, cfg) * (1 + mods.fireRateBonus)
  return Math.max(0, dmg * rate)
}

export function calcG(wave: number, cfg: GameConfig): number {
  const w = Math.max(1, Math.floor(wave))
  const { a, b, c, earlyEnd, midEnd } = cfg.progression

  if (w <= earlyEnd) return Math.pow(1 + a, w - 1)

  const early = Math.pow(1 + a, earlyEnd - 1)
  if (w <= midEnd) return early * Math.pow(1 + b, w - earlyEnd)

  const mid = early * Math.pow(1 + b, midEnd - earlyEnd)
  return mid * Math.pow(1 + c, w - midEnd)
}

export function calcTotalEHP(wave: number, dpsSnap: number, cfg: GameConfig): number {
  const T = cfg.sim.waveDurationSec
  const rho = cfg.progression.clearFactorRho
  const g = calcG(wave, cfg)
  return Math.max(1, dpsSnap * T * rho * g)
}

export function calcSpawnCount(wave: number, cfg: GameConfig, quality: GameState['settings']['quality']): number {
  const w = Math.max(1, Math.floor(wave))
  const { nMin, u, v } = cfg.progression
  const nBase = nMin + Math.floor(u * Math.sqrt(w) + v * Math.log(1 + w))

  const nMax = quality === 'low' ? cfg.progression.nMaxLow : quality === 'med' ? cfg.progression.nMaxMed : cfg.progression.nMaxHigh
  return clamp(nBase, nMin, nMax)
}

export function calcWavePattern(wave: number, cfg: GameConfig): number {
  const w = Math.max(1, Math.floor(wave))
  const { patternP1, patternP2, patternCountP } = cfg.progression
  return ((patternP1 * w + patternP2) % patternCountP + patternCountP) % patternCountP
}

export function calcSpawnTimeSec(wave: number, index1: number, spawnCount: number, cfg: GameConfig): number {
  const i = Math.max(1, Math.floor(index1))
  const N = Math.max(1, Math.floor(spawnCount))
  const T = cfg.sim.waveDurationSec

  const x = i / N
  const p = cfg.progression.spawnP
  let t = T * Math.pow(x, p)

  // Deterministic bursts on selected patterns.
  const pattern = calcWavePattern(wave, cfg)
  if (cfg.progression.burstPatternValues.includes(pattern)) {
    const tight = clamp(cfg.progression.burstTightness, 0, 1)
    t = t * (1 - tight) + (T * x) * tight
  }

  return clamp(t, 0, T)
}

export function calcEnemyTypeIndex(wave: number, index1: number, cfg: GameConfig, K: number): number {
  const w = Math.max(1, Math.floor(wave))
  const i = Math.max(1, Math.floor(index1))
  const { enemyTypeA: A, enemyTypeB: B, enemyTypeC: C } = cfg.progression
  const raw = A * w + B * i + C
  const mod = ((raw % K) + K) % K
  return mod
}

export function calcTypeVariationS(index1: number, cfg: GameConfig): number {
  const i = Math.max(1, Math.floor(index1))
  const m = Math.max(2, Math.floor(cfg.progression.typeVariationM))
  const beta = cfg.progression.typeVariationBeta
  const frac = (i % m) / (m - 1)
  return 1 + beta * (frac - 0.5)
}

export type EnemyStats = {
  type: EnemyTypeDef
  hp: number
  armor: number
  speed: number
}

export function calcEnemyStats(wave: number, index1: number, totalEHP: number, spawnCount: number, cfg: GameConfig): EnemyStats {
  const K = cfg.enemies.types.length
  const typeIndex = calcEnemyTypeIndex(wave, index1, cfg, K)
  const type = cfg.enemies.types[typeIndex]

  const per = Math.max(1, totalEHP / Math.max(1, spawnCount))
  const S = calcTypeVariationS(index1, cfg)

  const hp = Math.max(1, per * S * type.hpMult)

  const armorBase = Math.min(cfg.progression.armorMax, cfg.progression.armorAlpha * Math.log(1 + Math.max(1, wave)))
  const armor = clamp(armorBase * type.armorMult, 0, cfg.progression.armorMax)

  const speed = Math.max(1, type.baseSpeed * (1 + (cfg.progression.speedK * Math.sqrt(Math.max(1, wave))) / 100))

  return { type, hp, armor, speed }
}

export function calcThreshold(wave: number, cfg: GameConfig): number {
  const w = Math.max(1, Math.floor(wave))
  const { th0, thSlope, thMin, thMax } = cfg.progression
  return clamp(th0 + thSlope * Math.log(1 + w), thMin, thMax)
}

export function calcPenaltyFactor(killRatio: number, threshold: number, cfg: GameConfig): { penaltyFactor: number; deficit: number } {
  const kr = clamp(killRatio, 0, 1)
  const th = clamp(threshold, 0.0001, 1)

  if (kr >= th) return { penaltyFactor: 1.0, deficit: 0 }

  const deficit = (th - kr) / th
  const penaltyFactor = clamp(1.0 - cfg.progression.penK * deficit, cfg.progression.penMin, 1.0)
  return { penaltyFactor, deficit }
}

export function calcBaseGold(wave: number, totalEHP: number, cfg: GameConfig): number {
  const w = Math.max(1, Math.floor(wave))
  const base = cfg.progression.g0 * Math.pow(Math.max(1, totalEHP), cfg.progression.gamma)
  return base * (1 + cfg.progression.goldWaveK * Math.log(1 + w))
}

export function calcPointsReward(wave: number, cfg: GameConfig): number {
  const w = Math.max(1, Math.floor(wave))
  const tier = Math.floor((w - 1) / 10)
  return Math.max(1, Math.ceil(cfg.progression.p0 * Math.pow(cfg.progression.pointsGrowthPer10, tier)))
}

export function calcWaveSnapshot(state: GameState, cfg: GameConfig): WaveSnapshot {
  const dpsSnap = calcDPS(state, cfg)
  const totalEHP = calcTotalEHP(state.wave, dpsSnap, cfg)
  const spawnCount = calcSpawnCount(state.wave, cfg, state.settings.quality)
  const threshold = calcThreshold(state.wave, cfg)

  return {
    wave: state.wave,
    dpsSnap,
    totalEHP,
    spawnCount,
    threshold,
  }
}

export function calcWaveReport(args: {
  state: GameState
  snapshot: WaveSnapshot
  killed: number
  escaped: number
  cfg: GameConfig
}): WaveReport {
  const { snapshot, killed, escaped, cfg, state } = args
  const N = Math.max(1, snapshot.spawnCount)
  const killRatio = clamp(killed / N, 0, 1)
  const { penaltyFactor, deficit } = calcPenaltyFactor(killRatio, snapshot.threshold, cfg)

  const baseGold = calcBaseGold(snapshot.wave, snapshot.totalEHP, cfg)
  const rewardGold = baseGold * penaltyFactor * aggregateModules(state, cfg).goldMult
  const rewardPoints = calcPointsReward(snapshot.wave, cfg)

  const baseDamageFromEscapes = cfg.progression.enableEscapeDamage
    ? escaped * cfg.progression.escapeDamage * (1 + cfg.progression.deficitBoost * deficit)
    : 0

  return {
    wave: snapshot.wave,
    killed,
    escaped,
    killRatio,
    threshold: snapshot.threshold,
    penaltyFactor,
    rewardGold,
    rewardPoints,
    baseDamageFromEscapes,
    dpsSnap: snapshot.dpsSnap,
    totalEHP: snapshot.totalEHP,
  }
}
