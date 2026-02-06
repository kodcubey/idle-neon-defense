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

  // Modules start locked; unlock with Paladyum in the Modules screen.

  const modulesEquipped: Record<number, string | null> = {}
  for (let s = 1; s <= config.modules.slotCount; s++) modulesEquipped[s] = null

  return {
    version: config.version,
    lastSaveTimestampUTC: nowUTC,
    wave: 1,
    gold: 50,
    points: 0,
    paladyumCarry: 0,
    baseHP: config.tower.baseHP0,
    towerUpgrades: {
      damageLevel: 1,
      fireRateLevel: 1,
      rangeLevel: 1,
      baseHPLevel: 1,

      armorPierceLevel: 1,
      fortifyLevel: 1,
      repairLevel: 1,
      goldLevel: 1,
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

  // Settings: ensure object and force quality to HIGH (fixed).
  if (!merged.settings || typeof merged.settings !== 'object') merged.settings = { ...base.settings }
  merged.settings = { ...base.settings, ...merged.settings, quality: 'high' }

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

  // Clamp upgrades to config max levels (important if balance changes across versions).
  const rangeMax = config.tower.upgrades.maxLevels?.range
  if (typeof rangeMax === 'number' && Number.isFinite(rangeMax)) {
    merged.towerUpgrades.rangeLevel = Math.max(1, Math.min(Math.floor(rangeMax), Math.floor(merged.towerUpgrades.rangeLevel)))
  }

  if (typeof (merged.towerUpgrades as any).armorPierceLevel !== 'number') (merged.towerUpgrades as any).armorPierceLevel = (base.towerUpgrades as any).armorPierceLevel
  if (typeof (merged.towerUpgrades as any).fortifyLevel !== 'number') (merged.towerUpgrades as any).fortifyLevel = (base.towerUpgrades as any).fortifyLevel
  if (typeof (merged.towerUpgrades as any).repairLevel !== 'number') (merged.towerUpgrades as any).repairLevel = (base.towerUpgrades as any).repairLevel
  if (typeof (merged.towerUpgrades as any).goldLevel !== 'number') (merged.towerUpgrades as any).goldLevel = (base.towerUpgrades as any).goldLevel

  // Ensure module maps contain all defs.
  for (const def of config.modules.defs) {
    if (typeof merged.modulesUnlocked[def.id] !== 'boolean') merged.modulesUnlocked[def.id] = false
    if (typeof merged.moduleLevels[def.id] !== 'number') merged.moduleLevels[def.id] = 0
  }

  for (let s = 1; s <= config.modules.slotCount; s++) {
    if (!(s in merged.modulesEquipped)) merged.modulesEquipped[s] = null
  }

  // Offline progression is disabled; always refresh the save timestamp on load.
  merged.lastSaveTimestampUTC = nowUTC

  if (typeof (merged as any).paladyumCarry !== 'number' || !Number.isFinite((merged as any).paladyumCarry)) {
    ;(merged as any).paladyumCarry = 0
  }
  ;(merged as any).paladyumCarry = Math.max(0, Math.min(1, (merged as any).paladyumCarry))
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
