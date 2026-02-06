import type { GameConfig, TowerUpgradeKey } from '../types'

export type UpgradeKey = TowerUpgradeKey

export function upgradeMaxLevel(key: UpgradeKey, cfg: GameConfig): number {
  const m = cfg.tower.upgrades.maxLevels?.[key]
  return typeof m === 'number' && Number.isFinite(m) ? Math.max(1, Math.floor(m)) : Number.POSITIVE_INFINITY
}

// Cost for buying the *next* level when current level is `level`.
// Deterministic geometric growth is preserved; only a per-track multiplier is applied.
export function upgradeCost(key: UpgradeKey, level: number, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor(level))
  const multRaw = cfg.tower.upgrades.costMult?.[key]
  const mult = typeof multRaw === 'number' && Number.isFinite(multRaw) ? Math.max(0, multRaw) : 1
  return mult * cfg.economy.upgradeCostBase * Math.pow(cfg.economy.upgradeCostGrowth, L - 1)
}

export function moduleUnlockCostPoints(unlocksSoFar: number, cfg: GameConfig): number {
  const n = Math.max(0, Math.floor(unlocksSoFar))
  return Math.ceil(cfg.economy.moduleUnlockPointCostBase * Math.pow(cfg.economy.moduleUnlockPointCostGrowth, n))
}

// Slot purchase cost. First slot is free (state.moduleSlotsUnlocked starts at 1).
// Cost is for buying the *next* slot beyond the currently unlocked count.
export function moduleSlotUnlockCostPoints(currentSlotsUnlocked: number, cfg: GameConfig): number {
  const s = Math.max(1, Math.floor(currentSlotsUnlocked))
  const nPurchased = s - 1
  return Math.ceil(cfg.economy.moduleSlotUnlockPointCostBase * Math.pow(cfg.economy.moduleSlotUnlockPointCostGrowth, nPurchased))
}

export function moduleUpgradeCostGold(level: number, cfg: GameConfig): number {
  const L = Math.max(0, Math.floor(level))
  return cfg.economy.moduleUpgradeGoldBase * Math.pow(cfg.economy.moduleUpgradeGoldGrowth, L)
}

// Modules are upgraded with the meta currency ("points" / Paladyum). Keep the
// underlying economy fields unchanged to avoid breaking existing configs.
export function moduleUpgradeCostPoints(level: number, cfg: GameConfig): number {
  return moduleUpgradeCostGold(level, cfg)
}

export function sumGeometric(a1: number, r: number, n: number): number {
  if (n <= 0) return 0
  if (r === 1) return a1 * n
  return a1 * (1 - Math.pow(r, n)) / (1 - r)
}
