import type { GameConfig, GameState, TowerUpgradeKey } from '../types'
import { clamp, aggregateModules } from './deterministic'
import { metaUpgradeCostPoints, moduleSlotUnlockCostPoints, moduleUnlockCostPoints, moduleUpgradeCostPoints, skillsRespecCostPoints, upgradeCost, upgradeMaxLevel } from './costs'
import { aggregateSkillPassives, canBuySkill, defaultSkillState, getSkillRank, type SkillId } from '../skills/skills'
import {
  defaultLabState,
  finalizeResearchIfComplete,
  labEffectMult,
  researchCostPointsForNext,
  researchDurationSecForNext,
  sanitizeLabState,
  type LabKey,
} from '../labs/labs'

export function applyTowerUpgrade(args: {
  state: GameState
  cfg: GameConfig
  key: TowerUpgradeKey
  amount: 1 | 10 | 'max'
}): { ok: boolean; state: GameState } {
  const { cfg, key } = args
  const state: GameState = structuredClone(args.state)

  const skills = aggregateSkillPassives(state)

  const cur = getUpgradeLevel(state, key)
  const maxL = upgradeMaxLevel(key, cfg)
  if (cur >= maxL) return { ok: false, state: args.state }

  const buyCountRaw = args.amount === 'max' ? maxAffordableUpgrades(cur, state.gold, cfg, key, maxL, skills.shopGoldCostMult) : args.amount
  const buyCount = Math.min(buyCountRaw, Math.max(0, maxL - cur))
  if (buyCount <= 0) return { ok: false, state: args.state }

  // Sum discretely to stay consistent with maxAffordableUpgrades (and avoid float edge cases).
  let total = 0
  for (let i = 0; i < buyCount; i++) {
    total += upgradeCost(key, cur + i, cfg) * skills.shopGoldCostMult
    if (!Number.isFinite(total)) return { ok: false, state: args.state }
  }
  if (state.gold < total) return { ok: false, state: args.state }

  state.gold -= total
  setUpgradeLevel(state, key, cur + buyCount)

  // BaseHP track increases max; current HP is clamped to new max.
  const maxHP = calcBaseHPMax(state, cfg)
  state.baseHP = clamp(state.baseHP, 0, maxHP)

  return { ok: true, state }
}

export function applyTowerMetaUpgrade(args: {
  state: GameState
  cfg: GameConfig
  key: TowerUpgradeKey
  amount: 1 | 10 | 'max'
}): { ok: boolean; state: GameState } {
  const { cfg, key } = args
  const state: GameState = structuredClone(args.state)

  if (!state.towerMetaUpgrades || typeof state.towerMetaUpgrades !== 'object') return { ok: false, state: args.state }

  const cur = getUpgradeLevel({ ...state, towerUpgrades: state.towerMetaUpgrades } as any, key)
  const maxL = upgradeMaxLevel(key, cfg)
  if (cur >= maxL) return { ok: false, state: args.state }

  const buyCountRaw = args.amount === 'max' ? maxAffordableMetaUpgrades(cur, state.points, cfg, key, maxL) : args.amount
  const buyCount = Math.min(buyCountRaw, Math.max(0, maxL - cur))
  if (buyCount <= 0) return { ok: false, state: args.state }

  let total = 0
  let L = cur
  for (let i = 0; i < buyCount; i++) {
    total += metaUpgradeCostPoints(key, L, cfg)
    L++
  }
  if (state.points < total) return { ok: false, state: args.state }

  state.points -= total

  // Write meta level.
  const nextMeta = cur + buyCount
  ;(state.towerMetaUpgrades as any)[metaKeyFor(key)] = nextMeta

  // Ensure current run starts at least from meta.
  const curRun = getUpgradeLevel(state, key)
  if (curRun < nextMeta) setUpgradeLevel(state, key, nextMeta)

  // BaseHP track may increase max; clamp current HP.
  const maxHP = calcBaseHPMax(state, cfg)
  state.baseHP = clamp(state.baseHP, 0, maxHP)

  return { ok: true, state }
}

function metaKeyFor(key: TowerUpgradeKey): keyof GameState['towerMetaUpgrades'] {
  switch (key) {
    case 'damage':
      return 'damageLevel'
    case 'fireRate':
      return 'fireRateLevel'
    case 'crit':
      return 'critLevel'
    case 'multiShot':
      return 'multiShotLevel'
    case 'armorPierce':
      return 'armorPierceLevel'
    case 'range':
      return 'rangeLevel'
    case 'baseHP':
      return 'baseHPLevel'
    case 'slow':
      return 'slowLevel'
    case 'fortify':
      return 'fortifyLevel'
    case 'repair':
      return 'repairLevel'
    case 'gold':
      return 'goldLevel'
  }
}

function maxAffordableMetaUpgrades(currentLevel: number, points: number, cfg: GameConfig, key: Parameters<typeof upgradeMaxLevel>[0], maxL: number): number {
  let n = 0
  let p = points
  let L = Math.max(1, Math.floor(currentLevel))
  for (let iter = 0; iter < 10_000; iter++) {
    if (L >= maxL) break
    const c = metaUpgradeCostPoints(key, L, cfg)
    if (p < c) break
    p -= c
    L++
    n++
    if (n >= 10_000) break
  }
  return n
}

function maxAffordableUpgrades(
  currentLevel: number,
  gold: number,
  cfg: GameConfig,
  key: Parameters<typeof upgradeMaxLevel>[0],
  maxL: number,
  shopGoldCostMult: number,
): number {
  // Deterministic, bounded search.
  let n = 0
  let g = gold
  let L = Math.max(1, Math.floor(currentLevel))

  for (let iter = 0; iter < 10_000; iter++) {
    if (L >= maxL) break
    const c = upgradeCost(key, L, cfg) * shopGoldCostMult
    if (g < c) break
    g -= c
    L++
    n++
    if (n >= 10_000) break
  }
  return n
}

function getUpgradeLevel(
  state: GameState,
  key: TowerUpgradeKey,
): number {
  switch (key) {
    case 'damage':
      return state.towerUpgrades.damageLevel
    case 'fireRate':
      return state.towerUpgrades.fireRateLevel
    case 'crit':
      return (state.towerUpgrades as any).critLevel
    case 'multiShot':
      return (state.towerUpgrades as any).multiShotLevel
    case 'armorPierce':
      return (state.towerUpgrades as any).armorPierceLevel
    case 'range':
      return state.towerUpgrades.rangeLevel
    case 'baseHP':
      return state.towerUpgrades.baseHPLevel
    case 'slow':
      return (state.towerUpgrades as any).slowLevel
    case 'fortify':
      return (state.towerUpgrades as any).fortifyLevel
    case 'repair':
      return (state.towerUpgrades as any).repairLevel
    case 'gold':
      return (state.towerUpgrades as any).goldLevel
  }
}

function setUpgradeLevel(
  state: GameState,
  key: TowerUpgradeKey,
  level: number,
) {
  const L = Math.max(1, Math.floor(level))
  switch (key) {
    case 'damage':
      state.towerUpgrades.damageLevel = L
      return
    case 'fireRate':
      state.towerUpgrades.fireRateLevel = L
      return
    case 'crit':
      ;(state.towerUpgrades as any).critLevel = L
      return
    case 'multiShot':
      ;(state.towerUpgrades as any).multiShotLevel = L
      return
    case 'armorPierce':
      ;(state.towerUpgrades as any).armorPierceLevel = L
      return
    case 'range':
      state.towerUpgrades.rangeLevel = L
      return
    case 'baseHP':
      state.towerUpgrades.baseHPLevel = L
      return
    case 'slow':
      ;(state.towerUpgrades as any).slowLevel = L
      return
    case 'fortify':
      ;(state.towerUpgrades as any).fortifyLevel = L
      return
    case 'repair':
      ;(state.towerUpgrades as any).repairLevel = L
      return
    case 'gold':
      ;(state.towerUpgrades as any).goldLevel = L
      return
  }
}

export function calcBaseHPMax(state: GameState, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor(state.towerUpgrades.baseHPLevel))
  const defMult = labEffectMult((state as any).lab?.levels?.baseHP ?? 0)
  const g = Math.max(0, cfg.tower.baseHPGrowth * Math.max(0, defMult))
  const base = cfg.tower.baseHP0 * Math.pow(1 + g, L - 1)
  const mods = aggregateModules(state, cfg)
  const skills = aggregateSkillPassives(state)
  const raw = base + mods.baseHPBonus
  return Math.max(1, raw * mods.baseHPMult * skills.baseHPMult)
}

export function finalizeLab(args: { state: GameState; nowUTC: number }): { state: GameState; changed: boolean } {
  const state: GameState = structuredClone(args.state)
  ;(state as any).lab = sanitizeLabState((state as any).lab)
  const before = (state as any).lab
  const after = finalizeResearchIfComplete(before, args.nowUTC)
  if (after === before) return { state: args.state, changed: false }
  ;(state as any).lab = after
  return { state, changed: true }
}

export function startLabResearch(args: { state: GameState; cfg: GameConfig; key: TowerUpgradeKey; nowUTC: number }): { ok: boolean; state: GameState; reason?: string } {
  void args.cfg
  const state: GameState = structuredClone(args.state)
  ;(state as any).lab = sanitizeLabState((state as any).lab)
  state.lab = finalizeResearchIfComplete(state.lab, args.nowUTC)

  if (!state.lab) state.lab = defaultLabState() as any
  if (state.lab.research) return { ok: false, state: args.state, reason: 'Research already in progress.' }

  const key = args.key as LabKey
  const costPoints = researchCostPointsForNext(state.lab, key)
  const durSec = researchDurationSecForNext(state.lab, key)

  if (state.points < costPoints) return { ok: false, state: args.state, reason: 'Not enough Paladyum.' }

  state.points = Math.max(0, Math.floor(state.points - costPoints))
  state.lab.research = {
    key,
    startedAtUTC: Math.max(0, Math.floor(args.nowUTC)),
    endsAtUTC: Math.max(0, Math.floor(args.nowUTC + durSec * 1000)),
    boostsUsed: 0,
  }

  return { ok: true, state }
}

export function boostLabResearch(args: { state: GameState; cfg: GameConfig; nowUTC: number }): { ok: boolean; state: GameState; costPoints?: number; reason?: string } {
  void args.cfg
  void args.nowUTC
  return { ok: false, state: args.state, reason: 'Boost is disabled.' }
}

export function tryBuySkill(args: { state: GameState; cfg: GameConfig; id: SkillId }): { ok: boolean; state: GameState; reason?: string } {
  const state: GameState = structuredClone(args.state)
  if (!state.skills || typeof state.skills !== 'object') state.skills = defaultSkillState() as any

  const gate = canBuySkill(state, args.id)
  if (!gate.ok) return { ok: false, state: args.state, reason: gate.reason }

  const defRank = getSkillRank(state, args.id)
  state.skills.skillPoints = Math.max(0, Math.floor(state.skills.skillPoints) - 1)
  state.skills.nodes[args.id] = defRank + 1
  return { ok: true, state }
}

export function respecSkills(args: { state: GameState; cfg: GameConfig }): { ok: boolean; state: GameState; cost: number } {
  const state: GameState = structuredClone(args.state)
  if (!state.skills || typeof state.skills !== 'object') state.skills = defaultSkillState() as any

  const spent = Object.values(state.skills.nodes ?? {}).reduce<number>(
    (acc, v) => acc + (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0),
    0,
  )
  const cost = skillsRespecCostPoints(state.skills.respecCount ?? 0)
  if (state.points < cost) return { ok: false, state: args.state, cost }

  state.points -= cost
  state.skills.respecCount = Math.max(0, Math.floor(state.skills.respecCount ?? 0) + 1)
  state.skills.skillPoints = Math.max(0, Math.floor(state.skills.skillPoints ?? 0) + spent)
  state.skills.nodes = {}
  state.skills.cooldowns = { secondBreathWaves: 0, emergencyKitWaves: 0 }
  return { ok: true, state, cost }
}

export function tryModuleUnlock(args: { state: GameState; cfg: GameConfig; id: string }): { ok: boolean; state: GameState } {
  const { cfg, id } = args
  const state: GameState = structuredClone(args.state)

  if (!(id in state.modulesUnlocked)) return { ok: false, state: args.state }
  if (state.modulesUnlocked[id]) return { ok: false, state: args.state }

  const unlockedCount = Object.values(state.modulesUnlocked).filter(Boolean).length
  const cost = moduleUnlockCostPoints(unlockedCount, cfg)
  if (state.points < cost) return { ok: false, state: args.state }

  state.points -= cost
  state.modulesUnlocked[id] = true
  return { ok: true, state }
}

export function tryModuleUpgrade(args: {
  state: GameState
  cfg: GameConfig
  id: string
  amount: 1 | 10 | 'max'
}): { ok: boolean; state: GameState } {
  const { cfg, id } = args
  const state: GameState = structuredClone(args.state)

  if (!(id in state.moduleLevels)) return { ok: false, state: args.state }
  if (!state.modulesUnlocked[id]) return { ok: false, state: args.state }

  const cur = Math.max(1, Math.floor(state.moduleLevels[id] ?? 1))

  const buyCount = args.amount === 'max' ? maxAffordableModuleLevels(cur, state.points, cfg) : args.amount
  if (buyCount <= 0) return { ok: false, state: args.state }

  let total = 0
  let L = cur
  for (let i = 0; i < buyCount; i++) {
    total += moduleUpgradeCostPoints(L, cfg)
    L++
  }
  if (state.points < total) return { ok: false, state: args.state }

  state.points -= total
  state.moduleLevels[id] = cur + buyCount

  // If HP module affects maxHP, clamp current.
  state.baseHP = clamp(state.baseHP, 0, calcBaseHPMax(state, cfg))

  return { ok: true, state }
}

export function tryUnlockModuleSlot(args: { state: GameState; cfg: GameConfig }): { ok: boolean; state: GameState } {
  const { cfg } = args
  const state: GameState = structuredClone(args.state)

  const max = Math.max(1, Math.floor(cfg.modules.slotCount))
  const cur = Math.max(1, Math.floor(state.moduleSlotsUnlocked ?? 1))
  if (cur >= max) return { ok: false, state: args.state }

  const cost = moduleSlotUnlockCostPoints(cur, cfg)
  if (state.points < cost) return { ok: false, state: args.state }

  state.points -= cost
  state.moduleSlotsUnlocked = cur + 1
  return { ok: true, state }
}

function maxAffordableModuleLevels(currentLevel: number, points: number, cfg: GameConfig): number {
  let n = 0
  let p = points
  let L = Math.max(1, Math.floor(currentLevel))
  for (let iter = 0; iter < 10_000; iter++) {
    const c = moduleUpgradeCostPoints(L, cfg)
    if (p < c) break
    p -= c
    L++
    n++
    if (n >= 10_000) break
  }
  return n
}

export function equipModule(args: {
  state: GameState
  cfg: GameConfig
  slot: number
  id: string | null
}): { ok: boolean; state: GameState } {
  const { cfg, slot } = args
  const state: GameState = structuredClone(args.state)

  const s = Math.max(1, Math.floor(slot))
  const max = Math.max(1, Math.floor(cfg.modules.slotCount))
  const unlocked = Math.max(1, Math.floor(state.moduleSlotsUnlocked ?? 1))
  if (s < 1 || s > max) return { ok: false, state: args.state }
  if (s > unlocked) return { ok: false, state: args.state }

  if (args.id === null) {
    state.modulesEquipped[s] = null
    return { ok: true, state }
  }

  const id = args.id
  if (!state.modulesUnlocked[id]) return { ok: false, state: args.state }

  // A module card can only be equipped in one slot at a time.
  for (const [k, v] of Object.entries(state.modulesEquipped)) {
    const otherSlot = Math.max(1, Math.floor(Number(k)))
    if (otherSlot !== s && v === id) state.modulesEquipped[otherSlot] = null
  }

  state.modulesEquipped[s] = id
  // Clamp HP if needed.
  state.baseHP = clamp(state.baseHP, 0, calcBaseHPMax(state, cfg))
  return { ok: true, state }
}
