import type { GameConfig, GameState, Settings, Stats } from '../types'

const STORAGE_KEY = 'neon-grid.save.v1'

function defaultSettings(): Settings {
  return {
    audioMaster: 0.8,
    quality: 'high',
    numberFormat: 'suffix',
    reduceEffects: false,
    language: 'en',
  }
}

function defaultStats(): Stats {
  return {
    totalKills: 0,
    totalEscapes: 0,
    bestWave: 1,
    runsCount: 0,
    totalTimeSec: 0,
  }
}

export function createNewState(config: GameConfig, nowUTC: number): GameState {
  const modulesUnlocked: Record<string, boolean> = {}
  const moduleLevels: Record<string, number> = {}
  for (const def of config.modules.defs) {
    modulesUnlocked[def.id] = false
    moduleLevels[def.id] = 0
  }

  // Deterministic default: unlock first 2 modules for onboarding.
  const first = config.modules.defs[0]
  const second = config.modules.defs[1]
  if (first) modulesUnlocked[first.id] = true
  if (second) modulesUnlocked[second.id] = true

  const modulesEquipped: Record<number, string | null> = {}
  for (let s = 1; s <= config.modules.slotCount; s++) modulesEquipped[s] = null

  return {
    version: config.version,
    lastSaveTimestampUTC: nowUTC,
    wave: 1,
    gold: 0,
    points: 0,
    baseHP: config.tower.baseHP0,
    towerUpgrades: {
      damageLevel: 1,
      fireRateLevel: 1,
      rangeLevel: 1,
      baseHPLevel: 1,
    },
    modulesUnlocked,
    modulesEquipped,
    moduleLevels,
    prestigePoints: 0,
    settings: defaultSettings(),
    stats: defaultStats(),
  }
}

export function loadOrCreateSave(config: GameConfig, nowUTC: number): { state: GameState } {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return { state: createNewState(config, nowUTC) }

  try {
    const parsed = JSON.parse(raw) as GameState
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid save')

    // Minimal forward-compat: rehydrate missing fields deterministically.
    const state = migrateAndFixup(config, parsed, nowUTC)
    return { state }
  } catch {
    return { state: createNewState(config, nowUTC) }
  }
}

function migrateAndFixup(config: GameConfig, input: GameState, nowUTC: number): GameState {
  const base = createNewState(config, nowUTC)
  const merged: GameState = {
    ...base,
    ...input,
    version: config.version,
  }

  // Legacy compatibility: if older saves had towerLevel, map it to damageLevel.
  const anyMerged = merged as unknown as { towerLevel?: number }
  if (!merged.towerUpgrades || typeof merged.towerUpgrades !== 'object') {
    merged.towerUpgrades = { ...base.towerUpgrades }
  }
  if (typeof merged.towerUpgrades.damageLevel !== 'number') {
    merged.towerUpgrades.damageLevel = typeof anyMerged.towerLevel === 'number' ? anyMerged.towerLevel : base.towerUpgrades.damageLevel
  }
  if (typeof merged.towerUpgrades.fireRateLevel !== 'number') merged.towerUpgrades.fireRateLevel = base.towerUpgrades.fireRateLevel
  if (typeof merged.towerUpgrades.rangeLevel !== 'number') merged.towerUpgrades.rangeLevel = base.towerUpgrades.rangeLevel
  if (typeof merged.towerUpgrades.baseHPLevel !== 'number') merged.towerUpgrades.baseHPLevel = base.towerUpgrades.baseHPLevel

  // Ensure module maps contain all defs.
  for (const def of config.modules.defs) {
    if (typeof merged.modulesUnlocked[def.id] !== 'boolean') merged.modulesUnlocked[def.id] = false
    if (typeof merged.moduleLevels[def.id] !== 'number') merged.moduleLevels[def.id] = 0
  }

  for (let s = 1; s <= config.modules.slotCount; s++) {
    if (!(s in merged.modulesEquipped)) merged.modulesEquipped[s] = null
  }

  if (!merged.lastSaveTimestampUTC || merged.lastSaveTimestampUTC <= 0) merged.lastSaveTimestampUTC = nowUTC
  return merged
}

export function saveSnapshot(config: GameConfig, state: GameState) {
  const snapshot: GameState = {
    ...state,
    version: config.version,
    lastSaveTimestampUTC: Date.now(),
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
}

export function exportSave(): string {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw ?? ''
}

export function importSave(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return false
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
    return true
  } catch {
    return false
  }
}

export function clearSave() {
  localStorage.removeItem(STORAGE_KEY)
}
