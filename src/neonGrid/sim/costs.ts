import type { GameConfig } from '../types'

export type UpgradeKey = 'damage' | 'fireRate' | 'range' | 'baseHP'

export function upgradeCost(level: number, cfg: GameConfig): number {
  const L = Math.max(1, Math.floor(level))
  return cfg.economy.upgradeCostBase * Math.pow(cfg.economy.upgradeCostGrowth, L - 1)
}

export function moduleUnlockCostPoints(unlocksSoFar: number, cfg: GameConfig): number {
  const n = Math.max(0, Math.floor(unlocksSoFar))
  return Math.ceil(cfg.economy.moduleUnlockPointCostBase * Math.pow(cfg.economy.moduleUnlockPointCostGrowth, n))
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
