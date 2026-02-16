import type { EnemyTypeDef, GameConfig, GameState, ModuleDef, WaveReport, WaveSnapshot } from '../types'
import { aggregateSkillPassives } from '../skills/skills'

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
  pointsMult: number

  thresholdAdd: number
  penKMult: number
  penMinAdd: number
  spawnCountMult: number

  enemyHpMult: number
  enemyArmorMult: number

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
  let pointsMult = 1

  let thresholdAdd = 0
  let penKMult = 1
  let penMinAdd = 0
  let spawnCountMult = 1

  let enemyHpMult = 1
  let enemyArmorMult = 1

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
    if (def.pointsMultPerLevel) pointsMult *= 1 + def.pointsMultPerLevel * effLevel

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

    if (def.thresholdAddPerLevel) thresholdAdd += def.thresholdAddPerLevel * effLevel
    if (def.penKMultPerLevel) penKMult *= 1 + def.penKMultPerLevel * effLevel
    if (def.penMinAddPerLevel) penMinAdd += def.penMinAddPerLevel * effLevel
    if (def.spawnCountMultPerLevel) spawnCountMult *= 1 + def.spawnCountMultPerLevel * effLevel

    if (def.enemyHpMultPerLevel) enemyHpMult *= 1 + def.enemyHpMultPerLevel * effLevel
    if (def.enemyArmorMultPerLevel) enemyArmorMult *= 1 + def.enemyArmorMultPerLevel * effLevel
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
    pointsMult: clamp(pointsMult, 0, 10),

    thresholdAdd: clamp(thresholdAdd, -0.35, 0.35),
    penKMult: clamp(penKMult, 0.2, 3.0),
    penMinAdd: clamp(penMinAdd, -0.5, 0.5),
    spawnCountMult: clamp(spawnCountMult, 0.5, 2.0),

    enemyHpMult: clamp(enemyHpMult, 0.3, 5.0),
    enemyArmorMult: clamp(enemyArmorMult, 0.3, 5.0),

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
  const skills = aggregateSkillPassives(state)

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

  // Skills: add deterministic crit chance (Critical Primer) by converting chance into everyN.
  const baseChance = Number.isFinite(everyN) && everyN !== Number.POSITIVE_INFINITY ? 1 / Math.max(2, everyN) : 0
  const chance = clamp(baseChance + Math.max(0, skills.critChanceAdd), 0, 0.35)

  // If skills provide crit chance but there is no crit mult yet, bootstrap to a conservative mult.
  const multWithAdd = mult + Math.max(0, skills.critMultAdd)
  const finalMult = chance > 0.000001 ? Math.max(multWithAdd, 1.5) : multWithAdd

  if (!(finalMult > 1.000001)) return { everyN: Number.POSITIVE_INFINITY, mult: 1 }
  if (!(chance > 0.000001)) return { everyN: Number.POSITIVE_INFINITY, mult: 1 }
  const finalEveryN = clamp(Math.floor(1 / chance), 2, 10_000)
  return { everyN: finalEveryN, mult: finalMult }
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
  const skills = aggregateSkillPassives(state)
  return clamp(clamp(raw, min, 1) * skills.escapeDamageTakenMult, 0, 10)
}

export function towerRepairPctPerSec(state: GameState, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor((state.towerUpgrades as any).repairLevel ?? 1))
  const per = cfg.tower.upgrades.repairPctPerSecPerLevel
  const cap = cfg.tower.upgrades.repairMaxPctPerSec
  const skills = aggregateSkillPassives(state)
  return clamp(per * (L - 1) * Math.max(0, skills.repairPctMult), 0, cap)
}

export function calcDPS(state: GameState, cfg: GameConfig): number {
  const mods = aggregateModules(state, cfg)
  const skills = aggregateSkillPassives(state)
  const critAvg = critAverageDamageMult(state, cfg, mods)
  const dmg =
    (baseDmg(state.towerUpgrades.damageLevel, cfg) * mods.dmgMult * skills.dmgMult + mods.dmgFlat) *
    critAvg *
    calcPrestigeMult(state.prestigePoints, cfg)
  const rate = fireRate(state.towerUpgrades.fireRateLevel, cfg) * (1 + mods.fireRateBonus + skills.fireRateBonus)
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

export function calcSpawnCount(wave: number, cfg: GameConfig, quality: GameState['settings']['quality'], mods?: ModuleAggregate): number {
  const w = Math.max(1, Math.floor(wave))
  const { nMin, u, v } = cfg.progression
  const nBase = nMin + Math.floor(u * Math.sqrt(w) + v * Math.log(1 + w))

  const nMax = quality === 'low' ? cfg.progression.nMaxLow : quality === 'med' ? cfg.progression.nMaxMed : cfg.progression.nMaxHigh

  const m = mods ?? ({ spawnCountMult: 1 } as ModuleAggregate)
  const scaled = Math.round(nBase * (Number.isFinite(m.spawnCountMult) ? m.spawnCountMult : 1))
  return clamp(scaled, nMin, nMax)
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

export function calcEnemyStats(wave: number, index1: number, totalEHP: number, spawnCount: number, cfg: GameConfig, mods?: ModuleAggregate): EnemyStats {
  const K = cfg.enemies.types.length
  const typeIndex = calcEnemyTypeIndex(wave, index1, cfg, K)
  const type = cfg.enemies.types[typeIndex]

  const per = Math.max(1, totalEHP / Math.max(1, spawnCount))
  const S = calcTypeVariationS(index1, cfg)

  const m = mods ?? ({ enemyHpMult: 1, enemyArmorMult: 1 } as ModuleAggregate)
  const hp = Math.max(1, per * S * type.hpMult * (Number.isFinite(m.enemyHpMult) ? m.enemyHpMult : 1))

  const armorBase = Math.min(cfg.progression.armorMax, cfg.progression.armorAlpha * Math.log(1 + Math.max(1, wave)))
  const armor = clamp(armorBase * type.armorMult * (Number.isFinite(m.enemyArmorMult) ? m.enemyArmorMult : 1), 0, cfg.progression.armorMax)

  const speed = Math.max(1, type.baseSpeed * (1 + (cfg.progression.speedK * Math.sqrt(Math.max(1, wave))) / 100))

  return { type, hp, armor, speed }
}

export function calcThreshold(wave: number, cfg: GameConfig, mods?: ModuleAggregate): number {
  const w = Math.max(1, Math.floor(wave))
  const { th0, thSlope, thMin, thMax } = cfg.progression
  const base = clamp(th0 + thSlope * Math.log(1 + w), thMin, thMax)
  const add = mods?.thresholdAdd ?? 0
  return clamp(base + add, 0, 1)
}

export function calcPenaltyFactor(
  killRatio: number,
  threshold: number,
  cfg: GameConfig,
  mods?: ModuleAggregate
): { penaltyFactor: number; deficit: number } {
  const kr = clamp(killRatio, 0, 1)
  const th = clamp(threshold, 0.0001, 1)

  if (kr >= th) return { penaltyFactor: 1.0, deficit: 0 }

  const deficit = (th - kr) / th
  const penK = cfg.progression.penK * clamp(mods?.penKMult ?? 1, 0.2, 3.0)
  const penMin = clamp(cfg.progression.penMin + clamp(mods?.penMinAdd ?? 0, -0.5, 0.5), 0, 1)
  const penaltyFactor = clamp(1.0 - penK * deficit, penMin, 1.0)
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

export function calcPaladyumDropChancePerKill(args: { wave: number; spawnCount: number; cfg: GameConfig }): number {
  const { wave, spawnCount, cfg } = args
  const N = Math.max(1, Math.floor(spawnCount))

  // Deterministic "drop" model (no RNG): we convert the old per-wave Paladyum baseline
  // into a per-kill probability, so expected Paladyum per wave is:
  //   E[points] ~= paladyumDropRate * basePointsPerWave
  // where basePointsPerWave follows p0 / pointsGrowthPer10 tiering.
  const basePointsPerWave = calcPointsReward(wave, cfg)
  const chance = (cfg.progression.paladyumDropRate * basePointsPerWave) / N

  // Safety clamp: even at high tiers, keep it a "rare" event.
  return clamp(chance, 0, 0.25)
}

export function calcPaladyumRewardForWave(state: GameState, wave: number, cfg: GameConfig): { reward: number; nextCarry: number } {
  // Paladyum (meta currency) reward:
  // - Deterministic, every wave.
  // - Tiered growth per 10 waves (smooth via carry so UI feels continuous).

  const w = Math.max(1, Math.floor(wave))
  const tier = Math.floor((w - 1) / 10)

  const basePerWave = Math.max(0, cfg.progression.p0 * Math.pow(cfg.progression.pointsGrowthPer10, tier))
  const reward = Math.max(0, Math.floor(basePerWave))
  void state
  return { reward, nextCarry: 0 }
}

export function calcWaveSnapshot(state: GameState, cfg: GameConfig): WaveSnapshot {
  const mods = aggregateModules(state, cfg)
  const dpsSnap = calcDPS(state, cfg)
  const totalEHP = calcTotalEHP(state.wave, dpsSnap, cfg)
  const spawnCount = calcSpawnCount(state.wave, cfg, state.settings.quality, mods)
  const threshold = calcThreshold(state.wave, cfg, mods)

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
  const mods = aggregateModules(state, cfg)
  const skills = aggregateSkillPassives(state)
  const { penaltyFactor, deficit } = calcPenaltyFactor(killRatio, snapshot.threshold, cfg, mods)

  const baseGold = calcBaseGold(snapshot.wave, snapshot.totalEHP, cfg)
  const rewardGold = baseGold * penaltyFactor * mods.goldMult * towerGoldMult(state, cfg) * skills.rewardGoldMult
  const basePoints = calcPointsReward(snapshot.wave, cfg)
  const rewardPoints = Math.max(0, Math.floor(basePoints * penaltyFactor * mods.pointsMult * skills.rewardPointsMult))

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
