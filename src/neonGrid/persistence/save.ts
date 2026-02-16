import type { GameConfig, GameState, Settings, Stats } from '../types'
import { exportEncryptedSaveString, importEncryptedSaveFile } from './encryptedSaveFile'
import { defaultSkillState } from '../skills/skills'
import { defaultLabState, finalizeResearchIfComplete, sanitizeLabState } from '../labs/labs'

const LOCAL_SAVE_KEY = 'neon-grid:local-save:v1'

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

    skills: defaultSkillState(),

    lab: defaultLabState(),
  }
}

export function rehydrateImportedState(config: GameConfig, input: GameState, nowUTC: number): GameState {
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

  // Remove deprecated modules from older saves (keeps state consistent with current config).
  const removedModuleIds = ['UT_SPLITSHOT_ARRAY']
  for (const id of removedModuleIds) {
    if (merged.modulesUnlocked && typeof merged.modulesUnlocked === 'object') delete (merged.modulesUnlocked as any)[id]
    if (merged.moduleLevels && typeof merged.moduleLevels === 'object') delete (merged.moduleLevels as any)[id]
    for (let s = 1; s <= config.modules.slotCount; s++) {
      if (merged.modulesEquipped?.[s] === id) merged.modulesEquipped[s] = null
    }
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

  // Skills: ensure object + sanitize.
  if (!(merged as any).skills || typeof (merged as any).skills !== 'object') (merged as any).skills = defaultSkillState()
  const baseSkills = defaultSkillState()
  const s = (merged as any).skills as any
  s.level = typeof s.level === 'number' && Number.isFinite(s.level) ? Math.max(0, Math.floor(s.level)) : baseSkills.level
  s.xp = typeof s.xp === 'number' && Number.isFinite(s.xp) ? Math.max(0, Math.floor(s.xp)) : baseSkills.xp
  s.skillPoints = typeof s.skillPoints === 'number' && Number.isFinite(s.skillPoints) ? Math.max(0, Math.floor(s.skillPoints)) : baseSkills.skillPoints
  s.respecCount = typeof s.respecCount === 'number' && Number.isFinite(s.respecCount) ? Math.max(0, Math.floor(s.respecCount)) : baseSkills.respecCount
  if (!s.nodes || typeof s.nodes !== 'object') s.nodes = {}
  for (const [k, v] of Object.entries(s.nodes as any)) {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
    ;(s.nodes as any)[k] = n
  }

  // Remove deprecated skills and refund spent skill points.
  const removedSkillIds = ['UT_WAVE_PLANNER', 'UT_ADVANCED_PLANNER', 'AT_T1_DMG_CELL_01']
  for (const id of removedSkillIds) {
    const r = (s.nodes as any)[id]
    const n = typeof r === 'number' && Number.isFinite(r) ? Math.max(0, Math.floor(r)) : 0
    if (n > 0) {
      s.skillPoints = Math.max(0, Math.floor(s.skillPoints + n))
    }
    delete (s.nodes as any)[id]
  }
  if (!s.cooldowns || typeof s.cooldowns !== 'object') s.cooldowns = { ...baseSkills.cooldowns }
  s.cooldowns.secondBreathWaves =
    typeof s.cooldowns.secondBreathWaves === 'number' && Number.isFinite(s.cooldowns.secondBreathWaves)
      ? Math.max(0, Math.floor(s.cooldowns.secondBreathWaves))
      : 0
  s.cooldowns.emergencyKitWaves =
    typeof s.cooldowns.emergencyKitWaves === 'number' && Number.isFinite(s.cooldowns.emergencyKitWaves)
      ? Math.max(0, Math.floor(s.cooldowns.emergencyKitWaves))
      : 0

  // Lab: ensure object + sanitize, and finalize any completed research on load.
  ;(merged as any).lab = sanitizeLabState((merged as any).lab)
  merged.lab = finalizeResearchIfComplete(merged.lab, nowUTC)

  return merged
}

export function buildSaveSnapshot(config: GameConfig, state: GameState, nowUTC: number = Date.now()): GameState {
  // Explicitly include only the known schema fields.
  // This drops any legacy/unknown properties that may exist in older saves.
  return {
    version: config.version,
    lastSaveTimestampUTC: nowUTC,

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

    skills: {
      ...(state.skills as any),
      nodes: { ...(state.skills?.nodes as any) },
      cooldowns: { ...(state.skills?.cooldowns as any) },
    },

    lab: {
      ...(state.lab as any),
      research: state.lab?.research ? { ...(state.lab.research as any) } : null,
    },

  }
}

let saveTimer: number | null = null
let latestToPersist: { config: GameConfig; snapshot: GameState } | null = null

export async function loadOrCreateSave(config: GameConfig, nowUTC: number): Promise<GameState> {
  try {
    const raw = localStorage.getItem(LOCAL_SAVE_KEY)
    if (raw && raw.trim()) {
      const imported = await importEncryptedSaveFile(config, raw)
      return rehydrateImportedState(config, imported, nowUTC)
    }
  } catch {
    // Ignore storage / crypto errors and fall back to a fresh state.
  }
  return createNewState(config, nowUTC)
}

export function clearLocalSave() {
  try {
    localStorage.removeItem(LOCAL_SAVE_KEY)
  } catch {
    // ignore
  }
}

export function saveSnapshot(config: GameConfig, state: GameState) {
  // Throttle to avoid encrypting/writing on every sim tick.
  latestToPersist = { config, snapshot: buildSaveSnapshot(config, state, Date.now()) }

  if (saveTimer != null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    const job = latestToPersist
    latestToPersist = null
    if (!job) return
    void (async () => {
      try {
        const text = await exportEncryptedSaveString(job.config, job.snapshot)
        localStorage.setItem(LOCAL_SAVE_KEY, text)
      } catch {
        // ignore (storage full / blocked / crypto unavailable)
      }
    })()
  }, 650)
}
