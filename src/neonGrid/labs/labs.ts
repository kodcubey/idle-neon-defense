import type { TowerUpgradeKey } from '../types'

export type LabKey = TowerUpgradeKey

export type LabResearch = {
  key: LabKey
  startedAtUTC: number
  endsAtUTC: number
  boostsUsed: number
}

export type LabState = {
  levels: Record<LabKey, number>
  research: LabResearch | null
}

export const LAB_KEYS: LabKey[] = ['damage', 'fireRate', 'crit', 'multiShot', 'armorPierce', 'baseHP', 'slow', 'fortify', 'repair', 'range', 'gold']

export function defaultLabState(): LabState {
  const levels = {} as Record<LabKey, number>
  for (const k of LAB_KEYS) levels[k] = 0
  return {
    levels,
    research: null,
  }
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0
  return Math.max(min, Math.min(max, n))
}

export function sanitizeLabState(input: any): LabState {
  const base = defaultLabState()

  const out: LabState = {
    levels: { ...base.levels },
    research: null,
  }

  // New schema: levels map.
  if (input?.levels && typeof input.levels === 'object') {
    for (const k of LAB_KEYS) {
      out.levels[k] = clampInt(input.levels[k], 0, 10_000)
    }
  } else {
    // Legacy schema migration (branch-based levels): distribute to grouped keys.
    const atk = clampInt(input?.attackLevel, 0, 10_000)
    const def = clampInt(input?.defenseLevel, 0, 10_000)
    const util = clampInt(input?.utilityLevel, 0, 10_000)

    const atkKeys: LabKey[] = ['damage', 'fireRate', 'crit', 'multiShot', 'armorPierce']
    const defKeys: LabKey[] = ['baseHP', 'slow', 'fortify', 'repair']
    const utilKeys: LabKey[] = ['range', 'gold']
    for (const k of atkKeys) out.levels[k] = atk
    for (const k of defKeys) out.levels[k] = def
    for (const k of utilKeys) out.levels[k] = util
  }

  const r = input?.research
  if (r && typeof r === 'object') {
    const key = r.key
    const okKey: LabKey | null = LAB_KEYS.includes(key) ? key : null
    const startedAtUTC = typeof r.startedAtUTC === 'number' && Number.isFinite(r.startedAtUTC) ? Math.max(0, Math.floor(r.startedAtUTC)) : 0
    const endsAtUTC = typeof r.endsAtUTC === 'number' && Number.isFinite(r.endsAtUTC) ? Math.max(0, Math.floor(r.endsAtUTC)) : 0
    const boostsUsed = clampInt(r.boostsUsed, 0, 1_000_000)

    if (okKey && endsAtUTC > 0) {
      out.research = {
        key: okKey,
        startedAtUTC,
        endsAtUTC: Math.max(endsAtUTC, startedAtUTC),
        boostsUsed,
      }
    }
  }

  // Ensure all keys exist.
  for (const k of LAB_KEYS) {
    const v = out.levels[k]
    out.levels[k] = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
  }

  return out
}

// --- Balance knobs (simple, deterministic) ---

// Each Lab level increases *per-level* upgrade effects by this percent.
// Example: 3 levels => +9% per-level effects.
const EFFECT_PER_LEVEL_BONUS = 0.03

// Research time grows in hours and is intentionally expensive.
const RESEARCH_BASE_HOURS = 2
const RESEARCH_TIME_GROWTH = 1.55

const RESEARCH_POINTS_BASE = 90
const RESEARCH_POINTS_GROWTH = 1.6

// Boosting uses Paladyum to reduce remaining time.
const BOOST_POINTS_BASE = 35
const BOOST_POINTS_GROWTH = 1.45
const BOOST_REDUCE_MINUTES = 30

export function labEffectMult(level: number): number {
  const L = Math.max(0, Math.floor(level))
  return Math.max(0, 1 + EFFECT_PER_LEVEL_BONUS * L)
}

export function labLevel(lab: LabState, key: LabKey): number {
  const v = lab?.levels?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
}

export function labEffectMultForKey(lab: LabState, key: LabKey): number {
  return labEffectMult(labLevel(lab, key))
}

export function nextResearchLevel(lab: LabState, key: LabKey): number {
  return labLevel(lab, key) + 1
}

export function researchDurationSecForNext(lab: LabState, key: LabKey): number {
  void key
  const nextL = nextResearchLevel(lab, key)
  const hours = RESEARCH_BASE_HOURS * Math.pow(RESEARCH_TIME_GROWTH, Math.max(0, nextL - 1))
  return Math.max(60, Math.floor(hours * 3600))
}

export function researchCostGoldForNext(lab: LabState, key: LabKey): number {
  void lab
  void key
  // Labs are researched with Paladyum only.
  return 0
}

export function researchCostPointsForNext(lab: LabState, key: LabKey): number {
  void key
  const nextL = nextResearchLevel(lab, key)
  const raw = RESEARCH_POINTS_BASE * Math.pow(RESEARCH_POINTS_GROWTH, Math.max(0, nextL - 1))
  return Math.max(0, Math.ceil(raw))
}

export function boostCostPoints(lab: LabState, key: LabKey, boostsUsed: number): number {
  void key
  const baseL = nextResearchLevel(lab, key)
  const n = Math.max(0, Math.floor(boostsUsed))
  const raw = BOOST_POINTS_BASE * Math.pow(BOOST_POINTS_GROWTH, Math.max(0, baseL - 1)) * Math.pow(1.08, n)
  return Math.max(1, Math.ceil(raw))
}

export function boostReduceSec(): number {
  return Math.max(60, Math.floor(BOOST_REDUCE_MINUTES * 60))
}

export function isResearchComplete(lab: LabState, nowUTC: number): boolean {
  const r = lab.research
  if (!r) return false
  return nowUTC >= r.endsAtUTC
}

export function finalizeResearchIfComplete(lab: LabState, nowUTC: number): LabState {
  if (!lab.research) return lab
  if (!isResearchComplete(lab, nowUTC)) return lab

  const doneKey = lab.research.key
  const next: LabState = { ...lab, research: null, levels: { ...lab.levels } }
  next.levels[doneKey] = labLevel(next, doneKey) + 1
  return next
}
