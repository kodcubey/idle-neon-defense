import type { EnemyTypeDef, GameConfig, GameState, ModuleDef, WaveReport, WaveSnapshot } from '../types'

export function dayIndexUTC(nowUTC: number): number {
  return Math.floor(nowUTC / 86400_000)
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export function calcPrestigeMult(prestigePoints: number, cfg: GameConfig): number {
  // Prestige system removed/disabled: keep multiplier at 1 for deterministic balance.
  void prestigePoints
  void cfg
  return 1
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
  baseHPMult: number
  goldMult: number

  shotCount: number
  invulnDurationSec: number
  invulnCooldownSec: number

  critEveryN: number
  critMult: number

  enemySpeedMult: number
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
  let baseHPMult = 1
  let goldMult = 1

  let shotCount = 1
  let invulnDurationSec = 0
  let invulnCooldownSec = 0

  let critEveryN = Number.POSITIVE_INFINITY
  let critMult = 1

  let enemySpeedMult = 1

  const maxSlots = Math.max(1, Math.floor(cfg.modules.slotCount))
  const unlockedSlots = Math.max(1, Math.floor(state.moduleSlotsUnlocked ?? 1))
  const activeSlots = Math.min(maxSlots, unlockedSlots)

  for (let slot = 1; slot <= activeSlots; slot++) {
    const id = state.modulesEquipped[slot]
    if (!id) continue
    if (!state.modulesUnlocked[id]) continue

    const def = defsById.get(id)
    if (!def) continue

    const rawLevel = Math.max(1, Math.floor(state.moduleLevels[id] ?? 1))
    const levelCap = typeof def.maxEffectiveLevel === 'number' && Number.isFinite(def.maxEffectiveLevel) ? Math.max(0, Math.floor(def.maxEffectiveLevel)) : rawLevel
    const level = Math.min(rawLevel, levelCap)
    if (level <= 0) continue

    const expRaw = (cfg.modules as any).levelExponent
    const exp = typeof expRaw === 'number' && Number.isFinite(expRaw) ? clamp(expRaw, 0.35, 1.0) : 1.0
    const effLevel = Math.max(0, Math.pow(level, exp))

    if (def.dmgMultPerLevel) dmgMult *= 1 + def.dmgMultPerLevel * effLevel
    if (def.dmgFlatPerLevel) dmgFlat += def.dmgFlatPerLevel * effLevel
    if (def.fireRateBonusPerLevel) fireRateBonus += def.fireRateBonusPerLevel * effLevel
    if (def.rangeBonusPerLevel) rangeBonus += def.rangeBonusPerLevel * effLevel
    if (def.armorPiercePerLevel) armorPierce += def.armorPiercePerLevel * effLevel
    if (def.baseHPBonusPerLevel) baseHPBonus += def.baseHPBonusPerLevel * effLevel
    if (def.goldMultPerLevel) goldMult *= 1 + def.goldMultPerLevel * effLevel

    if (def.baseHPMultPerLevel) baseHPMult *= 1 + def.baseHPMultPerLevel * effLevel

    if (def.shotCountPerLevel) {
      const cap = typeof def.shotCountCap === 'number' && Number.isFinite(def.shotCountCap) ? Math.max(1, Math.floor(def.shotCountCap)) : Number.POSITIVE_INFINITY
      const add = Math.floor(def.shotCountPerLevel * effLevel)
      shotCount = Math.min(cap, Math.max(1, shotCount + Math.max(0, add)))
    }

    if (def.invulnDurationSecPerLevel && def.invulnCooldownSec) {
      invulnDurationSec = Math.max(invulnDurationSec, Math.max(0, def.invulnDurationSecPerLevel * effLevel))
      invulnCooldownSec = Math.max(invulnCooldownSec, Math.max(0.1, def.invulnCooldownSec))
    }

    if (def.critEveryN && def.critMultPerLevel) {
      const n = Math.max(2, Math.floor(def.critEveryN))
      const m = 1 + Math.max(0, def.critMultPerLevel * effLevel)
      if (m > 1.000001) {
        critEveryN = Math.min(critEveryN, n)
        critMult = Math.max(critMult, m)
      }
    }

    if (def.enemySpeedMultPerLevel) {
      enemySpeedMult *= 1 + def.enemySpeedMultPerLevel * effLevel
    }
  }

  return {
    dmgMult,
    dmgFlat,
    fireRateBonus,
    rangeBonus,
    armorPierce: clamp(armorPierce, 0, 0.9),
    baseHPBonus,
    baseHPMult: clamp(baseHPMult, 0.2, 3.0),
    goldMult,

    shotCount: clamp(Math.floor(shotCount), 1, 8),
    invulnDurationSec,
    invulnCooldownSec,

    critEveryN,
    critMult,

    enemySpeedMult: clamp(enemySpeedMult, 0.25, 2.0),
  }
}

export function towerMultiShotCount(state: GameState, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor((state.towerUpgrades as any).multiShotLevel ?? 1))
  const max = Math.max(1, Math.floor(cfg.tower.upgrades.maxLevels.multiShot ?? 4))
  return clamp(L, 1, max)
}

export function towerEnemySpeedMult(state: GameState, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor((state.towerUpgrades as any).slowLevel ?? 1))
  const eff = Math.max(0, L - 1)
  const raw = 1 - cfg.tower.upgrades.slowPerLevel * eff
  return clamp(raw, cfg.tower.upgrades.slowMinMult, 1)
}

export function effectiveEnemySpeedMult(state: GameState, cfg: GameConfig, mods?: ModuleAggregate): number {
  const m = mods ?? aggregateModules(state, cfg)
  return clamp(towerEnemySpeedMult(state, cfg) * m.enemySpeedMult, 0.25, 1)
}

export function effectiveCritParams(state: GameState, cfg: GameConfig, mods?: ModuleAggregate): { everyN: number; mult: number } {
  const m = mods ?? aggregateModules(state, cfg)

  const L = Math.max(1, Math.floor((state.towerUpgrades as any).critLevel ?? 1))
  const eff = Math.max(0, L - 1)

  let towerEveryN = Number.POSITIVE_INFINITY
  let towerMult = 1
  if (eff > 0) {
    const rawN = cfg.tower.upgrades.critEveryNBase - cfg.tower.upgrades.critEveryNReducePerLevel * eff
    towerEveryN = clamp(Math.floor(rawN), cfg.tower.upgrades.critEveryNMin, cfg.tower.upgrades.critEveryNBase)
    towerMult = 1 + cfg.tower.upgrades.critMultPerLevel * eff
  }

  const everyN = Math.min(towerEveryN, m.critEveryN)
  const mult = Math.max(towerMult, m.critMult)
  if (!Number.isFinite(everyN) || everyN <= 0) return { everyN: Number.POSITIVE_INFINITY, mult: 1 }
  if (!(mult > 1.000001)) return { everyN: Number.POSITIVE_INFINITY, mult: 1 }
  return { everyN, mult }
}

export function critAverageDamageMult(state: GameState, cfg: GameConfig, mods?: ModuleAggregate): number {
  const { everyN, mult } = effectiveCritParams(state, cfg, mods)
  if (!Number.isFinite(everyN) || everyN === Number.POSITIVE_INFINITY) return 1
  // One crit every N shots => average multiplier.
  return 1 + (mult - 1) / Math.max(1, everyN)
}

export function towerArmorPierceBonus(state: GameState, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor((state.towerUpgrades as any).armorPierceLevel ?? 1))
  const per = cfg.tower.upgrades.armorPiercePerLevel
  const bonus = per * (L - 1)
  return clamp(bonus, 0, 0.9)
}

export function towerGoldMult(state: GameState, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor((state.towerUpgrades as any).goldLevel ?? 1))
  const per = cfg.tower.upgrades.goldMultPerLevel
  return Math.max(0, 1 + per * (L - 1))
}

export function towerEscapeDamageMult(state: GameState, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor((state.towerUpgrades as any).fortifyLevel ?? 1))
  const per = cfg.tower.upgrades.fortifyPerLevel
  const min = cfg.tower.upgrades.fortifyMinMult
  const raw = 1 - per * (L - 1)
  return clamp(raw, min, 1)
}

export function towerRepairPctPerSec(state: GameState, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor((state.towerUpgrades as any).repairLevel ?? 1))
  const per = cfg.tower.upgrades.repairPctPerSecPerLevel
  const cap = cfg.tower.upgrades.repairMaxPctPerSec
  return clamp(per * (L - 1), 0, cap)
}

export function calcDPS(state: GameState, cfg: GameConfig): number {
  const mods = aggregateModules(state, cfg)
  const critAvg = critAverageDamageMult(state, cfg, mods)
  const dmg =
    (baseDmg(state.towerUpgrades.damageLevel, cfg) * mods.dmgMult + mods.dmgFlat) *
    critAvg *
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

export function calcPaladyumRewardForWave(state: GameState, wave: number, cfg: GameConfig): { reward: number; nextCarry: number } {
  // Paladyum (meta currency) reward:
  // - Deterministic, every wave.
  // - Tiered growth per 10 waves (smooth via carry so UI feels continuous).

  const w = Math.max(1, Math.floor(wave))
  const tier = Math.floor((w - 1) / 10)

  const basePerWave = Math.max(0, cfg.progression.p0 * Math.pow(cfg.progression.pointsGrowthPer10, tier))
  const carry = typeof (state as any).paladyumCarry === 'number' && Number.isFinite((state as any).paladyumCarry) ? (state as any).paladyumCarry : 0

  const total = Math.max(0, basePerWave + carry)
  const reward = Math.floor(total)
  const nextCarry = clamp(total - reward, 0, 0.999999)

  return { reward, nextCarry }
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
  const rewardGold = baseGold * penaltyFactor * aggregateModules(state, cfg).goldMult * towerGoldMult(state, cfg)
  const rewardPoints = calcPaladyumRewardForWave(state, snapshot.wave, cfg).reward

  const baseDamageFromEscapes = cfg.progression.enableEscapeDamage
    ? escaped * cfg.progression.escapeDamage * (1 + cfg.progression.deficitBoost * deficit)
    : 0

  const baseDamageFromEscapesAfterFortify = baseDamageFromEscapes * towerEscapeDamageMult(state, cfg)

  return {
    wave: snapshot.wave,
    killed,
    escaped,
    killRatio,
    threshold: snapshot.threshold,
    penaltyFactor,
    rewardGold,
    rewardPoints,
    baseDamageFromEscapes: baseDamageFromEscapesAfterFortify,
    dpsSnap: snapshot.dpsSnap,
    totalEHP: snapshot.totalEHP,
  }
}
