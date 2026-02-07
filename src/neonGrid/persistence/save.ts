import type { GameConfig, GameState, Settings, Stats } from '../types'

const STORAGE_KEY = 'neon-grid.save.v1'

function defaultSettings(): Settings {
  return {
    audioMaster: 0.8,
    audioMuted: false,
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
    paladyumDroppedThisRun: 0,
  }
}

export function createNewState(config: GameConfig, nowUTC: number): GameState {
  const modulesUnlocked: Record<string, boolean> = {}
  const moduleLevels: Record<string, number> = {}
  for (const def of config.modules.defs) {
    modulesUnlocked[def.id] = false
    // Module levels start at 1 (consistent with tower upgrades).
    // Locked modules don't apply, so this only matters after unlock.
    moduleLevels[def.id] = 1
  }

  // Modules start locked; unlock with Paladyum in the Modules screen.

  const modulesEquipped: Record<number, string | null> = {}
  for (let s = 1; s <= config.modules.slotCount; s++) modulesEquipped[s] = null

  return {
    version: config.version,
    lastSaveTimestampUTC: nowUTC,
    wave: 1,
    gold: 35,
    points: 0,
    paladyumCarry: 0,
    baseHP: config.tower.baseHP0,

    towerMetaUpgrades: {
      damageLevel: 1,
      fireRateLevel: 1,
      critLevel: 1,
      multiShotLevel: 1,
      rangeLevel: 1,
      baseHPLevel: 1,

      armorPierceLevel: 1,
      slowLevel: 1,
      fortifyLevel: 1,
      repairLevel: 1,
      goldLevel: 1,
    },

    towerUpgrades: {
      damageLevel: 1,
      fireRateLevel: 1,
      critLevel: 1,
      multiShotLevel: 1,
      rangeLevel: 1,
      baseHPLevel: 1,

      armorPierceLevel: 1,
      slowLevel: 1,
      fortifyLevel: 1,
      repairLevel: 1,
      goldLevel: 1,
    },
    modulesUnlocked,
    modulesEquipped,
    moduleLevels,
    moduleSlotsUnlocked: 1,
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

  // Paladyum / prestige are integer-only.
  merged.points = typeof merged.points === 'number' && Number.isFinite(merged.points) ? Math.max(0, Math.floor(merged.points)) : 0
  merged.prestigePoints =
    typeof merged.prestigePoints === 'number' && Number.isFinite(merged.prestigePoints) ? Math.max(0, Math.floor(merged.prestigePoints)) : 0

  // Stats: ensure object and fill any missing fields.
  if (!merged.stats || typeof merged.stats !== 'object') merged.stats = { ...base.stats }
  merged.stats = { ...base.stats, ...merged.stats }
  for (const [k, v] of Object.entries(merged.stats as any)) {
    ;(merged.stats as any)[k] = typeof v === 'number' && Number.isFinite(v) ? v : (base.stats as any)[k]
  }
  merged.stats.totalKills = Math.max(0, Math.floor(merged.stats.totalKills))
  merged.stats.totalEscapes = Math.max(0, Math.floor(merged.stats.totalEscapes))
  merged.stats.bestWave = Math.max(1, Math.floor(merged.stats.bestWave))
  merged.stats.runsCount = Math.max(0, Math.floor(merged.stats.runsCount))
  merged.stats.totalTimeSec = Math.max(0, merged.stats.totalTimeSec)
  merged.stats.paladyumDroppedThisRun = Math.max(0, Math.floor(merged.stats.paladyumDroppedThisRun))

  // Meta upgrades: fill missing, clamp, and ensure run upgrades never start below meta.
  if (!(merged as any).towerMetaUpgrades || typeof (merged as any).towerMetaUpgrades !== 'object') {
    ;(merged as any).towerMetaUpgrades = { ...base.towerMetaUpgrades }
  }
  merged.towerMetaUpgrades = { ...base.towerMetaUpgrades, ...(merged as any).towerMetaUpgrades }
  for (const [k, v] of Object.entries(merged.towerMetaUpgrades as any)) {
    ;(merged.towerMetaUpgrades as any)[k] = typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1
  }

  // Settings: ensure object and force quality to HIGH (fixed).
  if (!merged.settings || typeof merged.settings !== 'object') merged.settings = { ...base.settings }
  merged.settings = { ...base.settings, ...merged.settings, quality: 'high' }

  // Clamp audio settings.
  const am = (merged.settings as any).audioMaster
  merged.settings.audioMaster = typeof am === 'number' && Number.isFinite(am) ? Math.max(0, Math.min(1, am)) : base.settings.audioMaster
  const muted = (merged.settings as any).audioMuted
  ;(merged.settings as any).audioMuted = typeof muted === 'boolean' ? muted : base.settings.audioMuted

  // Legacy compatibility: if older saves had towerLevel, map it to damageLevel.
  const anyMerged = merged as unknown as { towerLevel?: number }
  if (!merged.towerUpgrades || typeof merged.towerUpgrades !== 'object') {
    merged.towerUpgrades = { ...base.towerUpgrades }
  }
  if (typeof merged.towerUpgrades.damageLevel !== 'number') {
    merged.towerUpgrades.damageLevel = typeof anyMerged.towerLevel === 'number' ? anyMerged.towerLevel : base.towerUpgrades.damageLevel
  }
  if (typeof merged.towerUpgrades.fireRateLevel !== 'number') merged.towerUpgrades.fireRateLevel = base.towerUpgrades.fireRateLevel
  if (typeof (merged.towerUpgrades as any).critLevel !== 'number') (merged.towerUpgrades as any).critLevel = (base.towerUpgrades as any).critLevel
  if (typeof (merged.towerUpgrades as any).multiShotLevel !== 'number') (merged.towerUpgrades as any).multiShotLevel = (base.towerUpgrades as any).multiShotLevel
  if (typeof merged.towerUpgrades.rangeLevel !== 'number') merged.towerUpgrades.rangeLevel = base.towerUpgrades.rangeLevel
  if (typeof merged.towerUpgrades.baseHPLevel !== 'number') merged.towerUpgrades.baseHPLevel = base.towerUpgrades.baseHPLevel

  // Clamp upgrades to config max levels (important if balance changes across versions).
  const rangeMax = config.tower.upgrades.maxLevels?.range
  if (typeof rangeMax === 'number' && Number.isFinite(rangeMax)) {
    merged.towerUpgrades.rangeLevel = Math.max(1, Math.min(Math.floor(rangeMax), Math.floor(merged.towerUpgrades.rangeLevel)))
  }

  if (typeof (merged.towerUpgrades as any).armorPierceLevel !== 'number') (merged.towerUpgrades as any).armorPierceLevel = (base.towerUpgrades as any).armorPierceLevel
  if (typeof (merged.towerUpgrades as any).slowLevel !== 'number') (merged.towerUpgrades as any).slowLevel = (base.towerUpgrades as any).slowLevel
  if (typeof (merged.towerUpgrades as any).fortifyLevel !== 'number') (merged.towerUpgrades as any).fortifyLevel = (base.towerUpgrades as any).fortifyLevel
  if (typeof (merged.towerUpgrades as any).repairLevel !== 'number') (merged.towerUpgrades as any).repairLevel = (base.towerUpgrades as any).repairLevel
  if (typeof (merged.towerUpgrades as any).goldLevel !== 'number') (merged.towerUpgrades as any).goldLevel = (base.towerUpgrades as any).goldLevel

  // Ensure tower upgrades are at least the meta starting levels.
  for (const [k, v] of Object.entries(merged.towerMetaUpgrades as any)) {
    const metaL = typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1
    const cur = (merged.towerUpgrades as any)[k]
    const curL = typeof cur === 'number' && Number.isFinite(cur) ? Math.max(1, Math.floor(cur)) : 1
    ;(merged.towerUpgrades as any)[k] = Math.max(curL, metaL)
  }

  // Ensure module maps contain all defs.
  for (const def of config.modules.defs) {
    if (typeof merged.modulesUnlocked[def.id] !== 'boolean') merged.modulesUnlocked[def.id] = false
    if (typeof merged.moduleLevels[def.id] !== 'number' || !Number.isFinite(merged.moduleLevels[def.id])) merged.moduleLevels[def.id] = 1
    merged.moduleLevels[def.id] = Math.max(1, Math.floor(merged.moduleLevels[def.id]))
  }

  for (let s = 1; s <= config.modules.slotCount; s++) {
    if (!(s in merged.modulesEquipped)) merged.modulesEquipped[s] = null
  }

  if (typeof (merged as any).moduleSlotsUnlocked !== 'number' || !Number.isFinite((merged as any).moduleSlotsUnlocked)) {
    ;(merged as any).moduleSlotsUnlocked = 1
  }
  ;(merged as any).moduleSlotsUnlocked = Math.max(1, Math.min(config.modules.slotCount, Math.floor((merged as any).moduleSlotsUnlocked)))

  // Offline progression is disabled; always refresh the save timestamp on load.
  merged.lastSaveTimestampUTC = nowUTC

  // Paladyum is integer-only now; carry is deprecated.
  ;(merged as any).paladyumCarry = 0
  return merged
}

export function saveSnapshot(config: GameConfig, state: GameState) {
  // Explicitly persist only the known schema fields.
  // This drops any legacy/unknown properties that may exist in older saves.
  const snapshot: GameState = {
    version: config.version,
    lastSaveTimestampUTC: Date.now(),

    wave: state.wave,
    gold: state.gold,
    points: typeof state.points === 'number' && Number.isFinite(state.points) ? Math.max(0, Math.floor(state.points)) : 0,
    paladyumCarry: 0,

    baseHP: state.baseHP,

    towerMetaUpgrades: { ...(state.towerMetaUpgrades as any) },
    towerUpgrades: { ...(state.towerUpgrades as any) },

    modulesUnlocked: { ...state.modulesUnlocked },
    modulesEquipped: { ...state.modulesEquipped },
    moduleLevels: { ...state.moduleLevels },
    moduleSlotsUnlocked: state.moduleSlotsUnlocked,

    prestigePoints: typeof state.prestigePoints === 'number' && Number.isFinite(state.prestigePoints) ? Math.max(0, Math.floor(state.prestigePoints)) : 0,
    settings: { ...state.settings },
    stats: { ...state.stats },
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
