import type { GameConfig, GameState } from '../types'
import { clamp, aggregateModules } from './deterministic'
import { moduleSlotUnlockCostPoints, moduleUnlockCostPoints, moduleUpgradeCostPoints, upgradeCost, upgradeMaxLevel } from './costs'

export function applyTowerUpgrade(args: {
  state: GameState
  cfg: GameConfig
  key: 'damage' | 'fireRate' | 'armorPierce' | 'baseHP' | 'fortify' | 'repair' | 'range' | 'gold'
  amount: 1 | 10 | 'max'
}): { ok: boolean; state: GameState } {
  const { cfg, key } = args
  const state: GameState = structuredClone(args.state)

  const cur = getUpgradeLevel(state, key)
  const maxL = upgradeMaxLevel(key, cfg)
  if (cur >= maxL) return { ok: false, state: args.state }
  const growth = cfg.economy.upgradeCostGrowth

  const buyCountRaw = args.amount === 'max' ? maxAffordableUpgrades(cur, state.gold, cfg, key, maxL) : args.amount
  const buyCount = Math.min(buyCountRaw, Math.max(0, maxL - cur))
  if (buyCount <= 0) return { ok: false, state: args.state }

  const firstCost = upgradeCost(key, cur, cfg)
  // cost for next 'buyCount' levels starting at cur: geometric series from L=cur..cur+buyCount-1
  const cost = firstCost * (1 - Math.pow(growth, buyCount)) / (1 - growth)
  if (state.gold < cost) return { ok: false, state: args.state }

  state.gold -= cost
  setUpgradeLevel(state, key, cur + buyCount)

  // BaseHP track increases max; current HP is clamped to new max.
  const maxHP = calcBaseHPMax(state, cfg)
  state.baseHP = clamp(state.baseHP, 0, maxHP)

  return { ok: true, state }
}

function maxAffordableUpgrades(currentLevel: number, gold: number, cfg: GameConfig, key: Parameters<typeof upgradeMaxLevel>[0], maxL: number): number {
  // Deterministic, bounded search.
  let n = 0
  let g = gold
  let L = Math.max(1, Math.floor(currentLevel))

  for (let iter = 0; iter < 10_000; iter++) {
    if (L >= maxL) break
    const c = upgradeCost(key, L, cfg)
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
  key: 'damage' | 'fireRate' | 'armorPierce' | 'baseHP' | 'fortify' | 'repair' | 'range' | 'gold',
): number {
  switch (key) {
    case 'damage':
      return state.towerUpgrades.damageLevel
    case 'fireRate':
      return state.towerUpgrades.fireRateLevel
    case 'armorPierce':
      return (state.towerUpgrades as any).armorPierceLevel
    case 'range':
      return state.towerUpgrades.rangeLevel
    case 'baseHP':
      return state.towerUpgrades.baseHPLevel
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
  key: 'damage' | 'fireRate' | 'armorPierce' | 'baseHP' | 'fortify' | 'repair' | 'range' | 'gold',
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
    case 'armorPierce':
      ;(state.towerUpgrades as any).armorPierceLevel = L
      return
    case 'range':
      state.towerUpgrades.rangeLevel = L
      return
    case 'baseHP':
      state.towerUpgrades.baseHPLevel = L
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
  const base = cfg.tower.baseHP0 * Math.pow(1 + cfg.tower.baseHPGrowth, L - 1)
  const mods = aggregateModules(state, cfg)
  const raw = base + mods.baseHPBonus
  return Math.max(1, raw * mods.baseHPMult)
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
