import type { GameConfig, GameState } from '../types'

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export type SkillBranch = 'attack' | 'defense' | 'utility'

export type SkillEffects = {
  // Values are PER RANK unless maxRank=1.
  dmgPct?: number
  fireRatePct?: number
  armorPierce?: number
  rangePct?: number
  shotBonus?: number
  hpPct?: number
  // Negative = take less damage, positive = take more.
  escapeDmgTakenPct?: number
  goldPct?: number
  pointsPct?: number
  // Positive = cheaper shop, negative = more expensive.
  shopDiscountPct?: number
  critChance?: number
  critMult?: number
  xpPct?: number
  // Positive = shorter cooldowns.
  cooldownDiscountPct?: number
  repairPct?: number
}

export type SkillDef = {
  id: SkillId
  branch: SkillBranch
  tier: 1 | 2 | 3 | 4
  name: string
  description: string
  icon: string
  maxRank: 1 | 2 | 3
  requires?: Array<{ id: SkillId; rank?: number }>
  effects?: SkillEffects
}

// Skill IDs are branch-prefixed strings.
// This keeps the type manageable even with large trees (e.g. 40/40/40).
export type SkillId = `AT_${string}` | `DF_${string}` | `UT_${string}`

export const TIER1_MAX_UNLOCKS_PER_BRANCH = 6

export type SkillState = {
  level: number
  xp: number
  skillPoints: number
  nodes: Partial<Record<SkillId, number>>
  respecCount: number
  cooldowns: {
    secondBreathWaves: number
    emergencyKitWaves: number
  }
}

export function defaultSkillState(): SkillState {
  return {
    level: 0,
    xp: 0,
    skillPoints: 0,
    nodes: {},
    respecCount: 0,
    cooldowns: {
      secondBreathWaves: 0,
      emergencyKitWaves: 0,
    },
  }
}

function icon(svgPath: string): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">${svgPath}</svg>`
}

function iconAttack(): string {
  return icon(`<path d="M12 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M3 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M17 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" stroke="currentColor" stroke-width="2"/>`)
}

function iconDefense(): string {
  return icon(`<path d="M12 3l7 4v6c0 5-3 8-7 9-4-1-7-4-7-9V7l7-4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <path d="M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`)
}

function iconUtility(): string {
  return icon(`<path d="M12 3v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M12 18v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M4.2 7.2l2.1 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M17.7 14.7l2.1 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M20.8 7.2l-2.1 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M6.3 14.7l-2.1 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" stroke="currentColor" stroke-width="2"/>`)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtPct(p: number): string {
  const v = Math.round(Math.abs(p) * 100)
  return `${p < 0 ? '-' : '+'}${v}%`
}

function effectsToDescription(e: SkillEffects, maxRank: 1 | 2 | 3): string {
  const parts: string[] = []
  if (e.dmgPct) parts.push(`${fmtPct(e.dmgPct)} base damage`)
  if (e.fireRatePct) parts.push(`${fmtPct(e.fireRatePct)} attack speed`)
  if (e.critChance) parts.push(`${fmtPct(e.critChance)} crit chance`)
  if (e.critMult) parts.push(`${e.critMult < 0 ? '-' : '+'}${Math.round(Math.abs(e.critMult) * 100) / 100} crit multiplier`)
  if (e.armorPierce) parts.push(`${fmtPct(e.armorPierce)} armor piercing`)
  if (e.rangePct) parts.push(`${fmtPct(e.rangePct)} range`)
  if (e.shotBonus) parts.push(`+${e.shotBonus} extra shot${e.shotBonus === 1 ? '' : 's'}`)
  if (e.hpPct) parts.push(`${fmtPct(e.hpPct)} max HP`)
  if (e.escapeDmgTakenPct) parts.push(`${fmtPct(e.escapeDmgTakenPct)} escape damage taken`)
  if (e.repairPct) parts.push(`${fmtPct(e.repairPct)} repair effectiveness`)
  if (e.goldPct) parts.push(`${fmtPct(e.goldPct)} wave gold reward`)
  if (e.pointsPct) parts.push(`${fmtPct(e.pointsPct)} Palladium reward`)
  if (e.shopDiscountPct) parts.push(`${fmtPct(-e.shopDiscountPct)} shop prices`)
  if (e.xpPct) parts.push(`${fmtPct(e.xpPct)} XP gain`)
  if (e.cooldownDiscountPct) parts.push(`${fmtPct(-e.cooldownDiscountPct)} skill cooldowns`)

  const body = parts.length > 0 ? parts.join(', ') : '—'
  if (maxRank === 1) return `Gain: ${body}.`
  return `Each rank: ${body}.`
}

function genUniqueSeries(opts: {
  branch: SkillBranch
  tier: 1 | 2 | 3 | 4
  prefix: string
  names: string[]
  effects: SkillEffects[]
  maxRank: 1 | 2 | 3
  icon: string
  requires?: Array<{ id: SkillId; rank?: number }>
}): SkillDef[] {
  const out: SkillDef[] = []
  for (let i = 1; i <= opts.names.length; i++) {
    const e = opts.effects[i - 1] ?? {}
    out.push({
      id: `${opts.prefix}_${pad2(i)}` as SkillId,
      branch: opts.branch,
      tier: opts.tier,
      name: opts.names[i - 1] ?? `${opts.prefix} ${i}`,
      icon: opts.icon,
      maxRank: opts.maxRank,
      requires: opts.requires,
      effects: e,
      description: effectsToDescription(e, opts.maxRank),
    })
  }
  return out
}

export const SKILLS: SkillDef[] = [
  // ATTACK
  {
    id: 'AT_SHARPENED_STRIKES',
    branch: 'attack',
    tier: 1,
    name: 'Sharpened Strikes',
    effects: { dmgPct: 0.08 },
    description: 'Each rank: +8% base damage (max +24%).',
    icon: icon(`<path d="M4 20l7-7 3 3-7 7H4v-3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M13 6l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M14 4l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 3,
  },

  // ATTACK (Unique passives: +28, total Attack = 40)
  ...genUniqueSeries({
    branch: 'attack',
    tier: 1,
    prefix: 'AT_T1_DMG_CELL',
    names: ['Kinetic Rounds', 'Edge Etching', 'Burst Lacing', 'High-Caliber Feed'],
    effects: [{ dmgPct: 0.07 }, { dmgPct: 0.06, fireRatePct: 0.03 }, { dmgPct: 0.05, armorPierce: 0.03 }, { dmgPct: 0.05, critChance: 0.03 }],
    maxRank: 3,
    icon: iconAttack(),
  }).filter((s) => s.id !== ('AT_T1_DMG_CELL_01' as SkillId)),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 1,
    prefix: 'AT_T1_CRIT_CELL',
    names: ['Deadeye Primer', 'Reflex Sight', 'Lucky Chamber'],
    effects: [{ critChance: 0.05 }, { critChance: 0.04, dmgPct: 0.03 }, { critChance: 0.04, rangePct: 0.05 }],
    maxRank: 2,
    icon: iconAttack(),
  }),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 2,
    prefix: 'AT_T2_FIRE_CELL',
    names: ['Hot Cycling', 'Trigger Discipline', 'Overclock Springs'],
    effects: [{ fireRatePct: 0.08 }, { fireRatePct: 0.07, critChance: 0.03 }, { fireRatePct: 0.06, rangePct: 0.06 }],
    maxRank: 2,
    icon: iconAttack(),
  }),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 2,
    prefix: 'AT_T2_PIERCE_CELL',
    names: ['Pierce Driver', 'Shatter Needle'],
    effects: [{ armorPierce: 0.05, dmgPct: 0.03 }, { armorPierce: 0.06 }],
    maxRank: 2,
    icon: iconAttack(),
  }),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 2,
    prefix: 'AT_T2_CRITMULT_CELL',
    names: ['Amplified Impact', 'Knife-Edge Focus'],
    effects: [{ critMult: 0.14 }, { critMult: 0.12, dmgPct: 0.03 }],
    maxRank: 2,
    icon: iconAttack(),
    requires: [{ id: 'AT_CRITICAL_PRIMER', rank: 1 }],
  }),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 3,
    prefix: 'AT_T3_DMG_CELL',
    names: ['Apex Powder', 'Vortex Charge', 'Razor Pattern'],
    effects: [{ dmgPct: 0.10 }, { dmgPct: 0.08, critChance: 0.03 }, { dmgPct: 0.08, fireRatePct: 0.04 }],
    maxRank: 2,
    icon: iconAttack(),
  }),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 3,
    prefix: 'AT_T3_CRIT_CELL',
    names: ['Predator Instinct', 'Crosshair Memory'],
    effects: [{ critChance: 0.07 }, { critChance: 0.06, critMult: 0.08 }],
    maxRank: 2,
    icon: iconAttack(),
    requires: [{ id: 'AT_CRITICAL_PRIMER', rank: 1 }],
  }),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 3,
    prefix: 'AT_T3_PIERCE_CELL',
    names: ['Armor Break Logic', 'Penetrator Kit'],
    effects: [{ armorPierce: 0.07 }, { armorPierce: 0.06, dmgPct: 0.05 }],
    maxRank: 2,
    icon: iconAttack(),
  }),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 4,
    prefix: 'AT_T4_RANGE_CELL',
    names: ['Rangefinder Array', 'Sightline Extension'],
    effects: [{ rangePct: 0.22 }, { rangePct: 0.18, fireRatePct: 0.06 }],
    maxRank: 1,
    icon: iconAttack(),
  }),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 4,
    prefix: 'AT_T4_CRITMULT_CELL',
    names: ['Terminal Crit', 'Perfect Strike'],
    effects: [{ critMult: 0.35 }, { critChance: 0.10, critMult: 0.22 }],
    maxRank: 1,
    icon: iconAttack(),
    requires: [{ id: 'AT_CRITICAL_PRIMER', rank: 1 }],
  }),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 4,
    prefix: 'AT_T4_DMG_CELL',
    names: ['Glass-Cannon Core', 'Breakthrough Rounds'],
    effects: [{ dmgPct: 0.22, escapeDmgTakenPct: 0.08 }, { dmgPct: 0.18, armorPierce: 0.06 }],
    maxRank: 1,
    icon: iconAttack(),
  }),
  ...genUniqueSeries({
    branch: 'attack',
    tier: 4,
    prefix: 'AT_T4_SUPPRESSIVE',
    names: ['Suppressive Fire'],
    effects: [{ shotBonus: 1, fireRatePct: 0.04 }],
    maxRank: 1,
    icon: iconAttack(),
    requires: [{ id: 'AT_FOCUSED_BARRAGE', rank: 1 }],
  }),
  {
    id: 'AT_CRITICAL_PRIMER',
    branch: 'attack',
    tier: 1,
    name: 'Critical Primer',
    effects: { critChance: 0.05 },
    description: 'Each rank: +5% crit chance (max +15%).',
    icon: icon(`<path d="M12 3l8 6-8 12L4 9l8-6Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M9 12l2 2 4-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
    maxRank: 3,
  },
  {
    id: 'AT_TARGET_CALIBRATION',
    branch: 'attack',
    tier: 1,
    name: 'Target Calibration',
    effects: { dmgPct: 0.06, armorPierce: 0.015 },
    description: 'Each rank: +6% base damage and +1.5% armor piercing.',
    icon: icon(`<path d="M12 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M3 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M17 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" stroke="currentColor" stroke-width="2"/>`),
    maxRank: 3,
  },
  {
    id: 'AT_EXECUTION_WINDOW',
    branch: 'attack',
    tier: 2,
    name: 'Execution Window',
    description: 'Enemies below 20% HP take +12% damage.',
    icon: icon(`<path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M7 7l10 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 1,
  },
  {
    id: 'AT_COMBO_MOMENTUM',
    branch: 'attack',
    tier: 2,
    name: 'Combo Momentum',
    description: 'On consecutive hits (max 5 stacks): each stack +1% damage (max +5%). Miss resets.',
    icon: icon(`<path d="M6 16c2-6 4-8 12-8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M16 6l2 2-2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6 18h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 3,
  },
  {
    id: 'AT_HOT_BARREL',
    branch: 'attack',
    tier: 2,
    name: 'Hot Barrel',
    effects: { fireRatePct: 0.12 },
    description: 'Each rank: +12% attack speed (max +24%).',
    icon: icon(`<path d="M6 9h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M6 15h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M8 6c1 1 1 3 0 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
      <path d="M12 6c1 1 1 3 0 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
      <path d="M16 6c1 1 1 3 0 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 2,
  },
  {
    id: 'AT_PIERCING_HIT',
    branch: 'attack',
    tier: 3,
    name: 'Piercing Hit',
    effects: { armorPierce: 0.06 },
    description: 'Each rank: +6% armor piercing (max +12%).',
    icon: icon(`<path d="M4 12h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M14 8l6 4-6 4" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M7 9l0 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 2,
  },
  {
    id: 'AT_ADRENAL_BURST',
    branch: 'attack',
    tier: 3,
    name: 'Adrenal Burst',
    description: 'Wave start: 8s +10% attack speed. Cooldown: 1 wave.',
    icon: icon(`<path d="M12 3v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M7 10h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M6 21c2-6 10-6 12 0" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`),
    maxRank: 1,
  },
  {
    id: 'AT_OVERCHARGE',
    branch: 'attack',
    tier: 4,
    name: 'Overcharge',
    effects: { dmgPct: 0.25, escapeDmgTakenPct: 0.15 },
    description: '+25% damage, but +15% damage taken from escapes.',
    icon: icon(`<path d="M13 2L4 14h7l-1 8 10-12h-7l0-8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M4 14h7" stroke="currentColor" stroke-width="2" opacity="0.35"/>`),
    maxRank: 1,
  },
  {
    id: 'AT_CRIT_AMPLIFIER',
    branch: 'attack',
    tier: 3,
    name: 'Crit Amplifier',
    effects: { critMult: 0.2 },
    description: 'Each rank: +0.20 crit multiplier (max +0.40).',
    requires: [{ id: 'AT_CRITICAL_PRIMER', rank: 1 }],
    icon: icon(`<path d="M12 3l3 7 7 2-6 5 2 7-6-4-6 4 2-7-6-5 7-2 3-7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 2,
  },
  {
    id: 'AT_MARKED_TARGETS',
    branch: 'attack',
    tier: 4,
    name: 'Marked Targets',
    description: 'Enemies above 80% HP take +6% damage.',
    requires: [{ id: 'AT_TARGET_CALIBRATION', rank: 1 }],
    icon: icon(`<path d="M12 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M3 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M17 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" stroke="currentColor" stroke-width="2"/>`),
    maxRank: 1,
  },
  {
    id: 'AT_FOCUSED_BARRAGE',
    branch: 'attack',
    tier: 4,
    name: 'Focused Barrage',
    effects: { shotBonus: 1 },
    description: '+1 extra shot each attack cycle.',
    requires: [{ id: 'AT_HOT_BARREL', rank: 1 }],
    icon: icon(`<path d="M6 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M8 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
      <path d="M8 16h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 1,
  },

  // DEFENSE
  {
    id: 'DF_HARDENED_SKIN',
    branch: 'defense',
    tier: 1,
    name: 'Hardened Skin',
    effects: { escapeDmgTakenPct: -0.06 },
    description: 'Each rank: -6% damage taken from escapes (max -18%).',
    icon: icon(`<path d="M12 3l7 4v6c0 5-3 8-7 9-4-1-7-4-7-9V7l7-4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
    maxRank: 3,
  },

  // DEFENSE (Generated passives: +28, total Defense = 40)
  ...genUniqueSeries({
    branch: 'defense',
    tier: 1,
    prefix: 'DF_T1_HP_CELL',
    names: ['Plating Lattice', 'Bulkhead Seal', 'Hull Reserve', 'Reinforced Core'],
    effects: [{ hpPct: 0.08 }, { hpPct: 0.07, repairPct: 0.06 }, { hpPct: 0.06, escapeDmgTakenPct: -0.05 }, { hpPct: 0.06, repairPct: 0.08 }],
    maxRank: 3,
    icon: iconDefense(),
  }),
  ...genUniqueSeries({
    branch: 'defense',
    tier: 1,
    prefix: 'DF_T1_RESIST_CELL',
    names: ['Impact Dampers', 'Shock Mesh', 'Adaptive Foam'],
    effects: [{ escapeDmgTakenPct: -0.07 }, { escapeDmgTakenPct: -0.06, hpPct: 0.04 }, { escapeDmgTakenPct: -0.06, repairPct: 0.10 }],
    maxRank: 2,
    icon: iconDefense(),
  }),
  ...genUniqueSeries({
    branch: 'defense',
    tier: 2,
    prefix: 'DF_T2_REPAIR_CELL',
    names: ['Repair Nanites', 'Sealant Surge', 'Rebuild Loop'],
    effects: [{ repairPct: 0.18 }, { repairPct: 0.16, hpPct: 0.05 }, { repairPct: 0.14, escapeDmgTakenPct: -0.05 }],
    maxRank: 2,
    icon: iconDefense(),
  }),
  ...genUniqueSeries({
    branch: 'defense',
    tier: 2,
    prefix: 'DF_T2_RESIST_CELL',
    names: ['Damage Sink', 'Safehouse Layer'],
    effects: [{ escapeDmgTakenPct: -0.08, repairPct: 0.08 }, { escapeDmgTakenPct: -0.09 }],
    maxRank: 2,
    icon: iconDefense(),
  }),
  ...genUniqueSeries({
    branch: 'defense',
    tier: 2,
    prefix: 'DF_T2_HP_CELL',
    names: ['Fortified Joints', 'Emergency Braces'],
    effects: [{ hpPct: 0.09 }, { hpPct: 0.07, escapeDmgTakenPct: -0.06 }],
    maxRank: 2,
    icon: iconDefense(),
  }),
  ...genUniqueSeries({
    branch: 'defense',
    tier: 3,
    prefix: 'DF_T3_RESIST_CELL',
    names: ['Breakwater', 'Resilience Stack', 'Stability Plate'],
    effects: [{ escapeDmgTakenPct: -0.10 }, { escapeDmgTakenPct: -0.08, hpPct: 0.06 }, { escapeDmgTakenPct: -0.08, repairPct: 0.14 }],
    maxRank: 2,
    icon: iconDefense(),
  }),
  ...genUniqueSeries({
    branch: 'defense',
    tier: 3,
    prefix: 'DF_T3_REPAIR_CELL',
    names: ['Triage Buffer', 'Recovery Matrix'],
    effects: [{ repairPct: 0.22 }, { repairPct: 0.18, escapeDmgTakenPct: -0.07 }],
    maxRank: 2,
    icon: iconDefense(),
  }),
  ...genUniqueSeries({
    branch: 'defense',
    tier: 3,
    prefix: 'DF_T3_HP_CELL',
    names: ['Armor Weave', 'Citadel Kernel'],
    effects: [{ hpPct: 0.12 }, { hpPct: 0.10, repairPct: 0.16 }],
    maxRank: 2,
    icon: iconDefense(),
  }),
  ...genUniqueSeries({
    branch: 'defense',
    tier: 4,
    prefix: 'DF_T4_RESIST_CELL',
    names: ['Bulwark Frame', 'Last Stand Suite'],
    effects: [{ escapeDmgTakenPct: -0.18 }, { escapeDmgTakenPct: -0.14, hpPct: 0.12 }],
    maxRank: 1,
    icon: iconDefense(),
  }),
  ...genUniqueSeries({
    branch: 'defense',
    tier: 4,
    prefix: 'DF_T4_HP_CELL',
    names: ['Citadel Heart', 'Ironclad Reserve'],
    effects: [{ hpPct: 0.18, escapeDmgTakenPct: -0.08 }, { hpPct: 0.22 }],
    maxRank: 1,
    icon: iconDefense(),
  }),
  ...genUniqueSeries({
    branch: 'defense',
    tier: 4,
    prefix: 'DF_T4_REPAIR_CELL',
    names: ['Rapid Patch', 'Nano Reconstructor', 'Hull Reforging'],
    effects: [{ repairPct: 0.35 }, { repairPct: 0.30, escapeDmgTakenPct: -0.10 }, { repairPct: 0.28, hpPct: 0.12 }],
    maxRank: 1,
    icon: iconDefense(),
  }),
  {
    id: 'DF_VITAL_RESERVE',
    branch: 'defense',
    tier: 1,
    name: 'Vital Reserve',
    effects: { hpPct: 0.09 },
    description: 'Each rank: +9% max HP (max +27%).',
    icon: icon(`<path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 5.5-7 10-7 10Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M12 9v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
    maxRank: 3,
  },
  {
    id: 'DF_NANO_WEAVE',
    branch: 'defense',
    tier: 1,
    name: 'Nano Weave',
    effects: { repairPct: 0.17, hpPct: 0.01 },
    description: 'Each rank: +17% repair effectiveness and +1% max HP (max +34% repair, +2% HP).',
    icon: icon(`<path d="M7 7h10v10H7V7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M7 12h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
      <path d="M12 7v10" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 2,
  },
  {
    id: 'DF_GUARD_STEP',
    branch: 'defense',
    tier: 2,
    name: 'Guard Step',
    description: 'Every 10s, the next escape hit deals -20% damage (single-hit shield).',
    icon: icon(`<path d="M7 20v-7a5 5 0 0 1 10 0v7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M9 20h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
    maxRank: 1,
  },
  {
    id: 'DF_RECOVERY_PULSE',
    branch: 'defense',
    tier: 2,
    name: 'Recovery Pulse',
    description: 'Wave end: heal 2% max HP per rank (max 4%).',
    icon: icon(`<path d="M4 12h5l2-5 3 10 2-5h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M4 18h16" stroke="currentColor" stroke-width="2" opacity="0.35"/>`),
    maxRank: 2,
  },
  {
    id: 'DF_SHOCK_ABSORBERS',
    branch: 'defense',
    tier: 2,
    name: 'Shock Absorbers',
    description: 'While below 50% HP: escape damage taken -5% per rank (max -10%).',
    icon: icon(`<path d="M8 4v16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M16 4v16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M8 8h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M8 16h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 2,
  },
  {
    id: 'DF_STABILITY',
    branch: 'defense',
    tier: 3,
    name: 'Stability',
    description: 'Each rank: -15% deficit scaling on escape damage (max -30%).',
    icon: icon(`<path d="M6 19l6-14 6 14" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M8 14h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
    maxRank: 2,
  },
  {
    id: 'DF_SECOND_BREATH',
    branch: 'defense',
    tier: 3,
    name: 'Second Breath',
    description: 'Once when HP drops below 15%: heal 10% max HP. Cooldown: 3 waves.',
    icon: icon(`<path d="M12 4a8 8 0 1 0 8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 8v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
    maxRank: 1,
  },
  {
    id: 'DF_AEGIS_PROTOCOL',
    branch: 'defense',
    tier: 4,
    name: 'Aegis Protocol',
    description: 'Wave start: 1 shield charge that fully blocks the first escape hit.',
    icon: icon(`<path d="M12 3l7 4v6c0 5-3 8-7 9-4-1-7-4-7-9V7l7-4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M9 11l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
    maxRank: 1,
  },
  {
    id: 'DF_WAVE_BARRIER',
    branch: 'defense',
    tier: 3,
    name: 'Wave Barrier',
    description: 'Wave start: heal 3% max HP.',
    requires: [{ id: 'DF_VITAL_RESERVE', rank: 1 }],
    icon: icon(`<path d="M4 14c3-6 13-6 16 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M4 18c3-6 13-6 16 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
      <path d="M12 3v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
    maxRank: 1,
  },
  {
    id: 'DF_FORTRESS_PROTOCOL',
    branch: 'defense',
    tier: 4,
    name: 'Fortress Protocol',
    effects: { hpPct: 0.12, escapeDmgTakenPct: -0.12 },
    description: '+12% max HP and -12% escape damage taken.',
    icon: icon(`<path d="M12 3l7 4v6c0 5-3 8-7 9-4-1-7-4-7-9V7l7-4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
    maxRank: 1,
  },
  {
    id: 'DF_AEGIS_RESERVE',
    branch: 'defense',
    tier: 4,
    name: 'Aegis Reserve',
    description: 'Aegis Protocol gains +1 extra charge (second charge blocks 60%).',
    requires: [{ id: 'DF_AEGIS_PROTOCOL', rank: 1 }],
    icon: icon(`<path d="M12 3l7 4v6c0 5-3 8-7 9-4-1-7-4-7-9V7l7-4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M8 13h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
      <path d="M10 10h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
    maxRank: 1,
  },

  // UTILITY
  {
    id: 'UT_QUICK_HANDS',
    branch: 'utility',
    tier: 1,
    name: 'Quick Hands',
    effects: { fireRatePct: 0.06 },
    description: 'Each rank: +6% attack speed (max +18%).',
    icon: icon(`<path d="M7 14l3-8 2 6 2-4 3 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6 18h12" stroke="currentColor" stroke-width="2" opacity="0.35"/>`),
    maxRank: 3,
  },
  {
    id: 'UT_SCAVENGER_SENSE',
    branch: 'utility',
    tier: 1,
    name: 'Scavenger Sense',
    effects: { goldPct: 0.05 },
    description: 'Each rank: +5% wave gold reward (max +10%).',
    icon: icon(`<path d="M12 3l3 7 7 2-6 5 2 7-6-4-6 4 2-7-6-5 7-2 3-7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M12 9v6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 2,
  },
  {
    id: 'UT_FIELD_NOTES',
    branch: 'utility',
    tier: 1,
    name: 'Field Notes',
    effects: { xpPct: 0.06 },
    description: 'Each rank: +6% XP gain (max +18%).',
    icon: icon(`<path d="M7 4h10v16H7V4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M9 8h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
      <path d="M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 3,
  },
  {
    id: 'UT_EFFICIENCY',
    branch: 'utility',
    tier: 2,
    name: 'Efficiency',
    effects: { shopDiscountPct: 0.03 },
    description: 'Each rank: -3% gold shop prices (max -9%).',
    icon: icon(`<path d="M6 7h12v14H6V7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M8 11h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M8 15h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
    maxRank: 3,
  },
  {
    id: 'UT_SMART_TARGETING',
    branch: 'utility',
    tier: 2,
    name: 'Smart Targeting',
    effects: { rangePct: 0.05 },
    description: 'Each rank: +5% range (max +10%).',
    icon: icon(`<path d="M12 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M3 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M17 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" stroke="currentColor" stroke-width="2"/>`),
    maxRank: 2,
  },
  {
    id: 'UT_COOLDOWN_TUNING',
    branch: 'utility',
    tier: 3,
    name: 'Cooldown Tuning',
    effects: { cooldownDiscountPct: 0.09 },
    description: 'Each rank: -9% skill cooldowns (max -18%).',
    icon: icon(`<path d="M12 3a9 9 0 1 0 9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 7v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`),
    maxRank: 2,
  },
  {
    id: 'UT_EMERGENCY_KIT',
    branch: 'utility',
    tier: 3,
    name: 'Emergency Kit',
    description: 'Mid-wave once: heal 6% max HP. Cooldown: 2 waves.',
    icon: icon(`<path d="M7 7h10v14H7V7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M12 10v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M9 14h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`),
    maxRank: 1,
  },
  {
    id: 'UT_PALADYUM_SCANNER',
    branch: 'utility',
    tier: 3,
    name: 'Palladium Scanner',
    effects: { pointsPct: 0.06 },
    description: 'Each rank: +6% Palladium reward (max +12%).',
    requires: [{ id: 'UT_SCAVENGER_SENSE', rank: 1 }],
    icon: icon(`<path d="M12 4a8 8 0 1 0 8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 8v4l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 2,
  },
  {
    id: 'UT_TACTICAL_RELAY',
    branch: 'utility',
    tier: 4,
    name: 'Tactical Relay',
    description: 'Wave start: 6s +10% range (radar ping).',
    icon: icon(`<path d="M12 21a9 9 0 1 0-9-9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 12l7-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M12 12l-4 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 1,
  },
  {
    id: 'UT_BULK_BUYING',
    branch: 'utility',
    tier: 4,
    name: 'Bulk Buying',
    effects: { shopDiscountPct: 0.09 },
    description: 'Additional -9% gold shop prices.',
    requires: [{ id: 'UT_EFFICIENCY', rank: 2 }],
    icon: icon(`<path d="M6 7h12v6H6V7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M8 13v7h8v-7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M10 10h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.55"/>`),
    maxRank: 1,
  },

  // UTILITY (Generated passives: +28, total Utility = 40)
  ...genUniqueSeries({
    branch: 'utility',
    tier: 1,
    prefix: 'UT_T1_XP_CELL',
    names: ['Training Log', 'Field Journal', 'Lesson Archive'],
    effects: [{ xpPct: 0.08 }, { xpPct: 0.07, goldPct: 0.03 }, { xpPct: 0.06, cooldownDiscountPct: 0.04 }],
    maxRank: 3,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 1,
    prefix: 'UT_T1_GOLD_CELL',
    names: ['Loose Change', 'Side Contract'],
    effects: [{ goldPct: 0.08 }, { goldPct: 0.06, shopDiscountPct: 0.04 }],
    maxRank: 2,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 1,
    prefix: 'UT_T1_SHOP_CELL',
    names: ['Coupon Stack', 'Vendor Rapport'],
    effects: [{ shopDiscountPct: 0.06 }, { shopDiscountPct: 0.05, pointsPct: 0.04 }],
    maxRank: 2,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 2,
    prefix: 'UT_T2_GOLD_CELL',
    names: ['Profit Route', 'Efficient Haul', 'Quick Sale'],
    effects: [{ goldPct: 0.10 }, { goldPct: 0.08, xpPct: 0.04 }, { goldPct: 0.07, cooldownDiscountPct: 0.04 }],
    maxRank: 2,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 2,
    prefix: 'UT_T2_RANGE_CELL',
    names: ['Range Telemetry', 'Spotter Link'],
    effects: [{ rangePct: 0.10 }, { rangePct: 0.08, fireRatePct: 0.04 }],
    maxRank: 2,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 2,
    prefix: 'UT_T2_COOLDOWN_CELL',
    names: ['Cooldown Ledger', 'Timing Chart'],
    effects: [{ cooldownDiscountPct: 0.08 }, { cooldownDiscountPct: 0.06, shopDiscountPct: 0.03 }],
    maxRank: 2,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 3,
    prefix: 'UT_T3_POINTS_CELL',
    names: ['Scanner Array', 'Palladium Map', 'Drop Routing'],
    effects: [{ pointsPct: 0.10 }, { pointsPct: 0.08, goldPct: 0.04 }, { pointsPct: 0.07, xpPct: 0.05 }],
    maxRank: 2,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 3,
    prefix: 'UT_T3_XP_CELL',
    names: ['Mentor Notes', 'Accelerated Drills'],
    effects: [{ xpPct: 0.10 }, { xpPct: 0.08, cooldownDiscountPct: 0.05 }],
    maxRank: 2,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 3,
    prefix: 'UT_T3_SHOP_CELL',
    names: ['Wholesale Access', 'Bulk Contacts'],
    effects: [{ shopDiscountPct: 0.08 }, { shopDiscountPct: 0.06, goldPct: 0.05 }],
    maxRank: 2,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 4,
    prefix: 'UT_T4_POINTS_CELL',
    names: ['Palladium Magnet', 'Reactor Scanner', 'Prime Extractor'],
    effects: [{ pointsPct: 0.20 }, { pointsPct: 0.16, shopDiscountPct: 0.08 }, { pointsPct: 0.14, xpPct: 0.10 }],
    maxRank: 1,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 4,
    prefix: 'UT_T4_GOLD_CELL',
    names: ['Golden Route', 'Market Sweep'],
    effects: [{ goldPct: 0.18 }, { goldPct: 0.14, rangePct: 0.12 }],
    maxRank: 1,
    icon: iconUtility(),
  }),
  ...genUniqueSeries({
    branch: 'utility',
    tier: 4,
    prefix: 'UT_T4_COOLDOWN_CELL',
    names: ['Overclock Schedule', 'Master Timing'],
    effects: [{ cooldownDiscountPct: 0.16 }, { cooldownDiscountPct: 0.12, shopDiscountPct: 0.08 }],
    maxRank: 1,
    icon: iconUtility(),
  }),
]

export const SKILLS_BY_ID: Record<string, SkillDef> = SKILLS.reduce((acc, s) => {
  ;(acc as any)[s.id] = s
  return acc
}, {} as any)

export function getSkillRank(state: GameState, id: SkillId): number {
  const s = (state as any).skills as SkillState | undefined
  const raw = s?.nodes?.[id]
  const v = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0
  return Math.max(0, v)
}

export function branchSpentCount(state: GameState, branch: SkillBranch): number {
  const s = (state as any).skills as SkillState | undefined
  if (!s || !s.nodes) return 0
  let count = 0
  for (const def of SKILLS) {
    if (def.branch !== branch) continue
    const r = getSkillRank(state, def.id)
    if (r > 0) count++
  }
  return count
}

export function branchTier1UnlockedCount(state: GameState, branch: SkillBranch): number {
  let count = 0
  for (const def of SKILLS) {
    if (def.branch !== branch) continue
    if (def.tier !== 1) continue
    if (getSkillRank(state, def.id) > 0) count++
  }
  return count
}

export function tierRequirementCount(tier: 1 | 2 | 3 | 4): number {
  if (tier <= 1) return 0
  if (tier === 2) return 2
  if (tier === 3) return 4
  return 6
}

export function canBuySkill(state: GameState, id: SkillId): { ok: true } | { ok: false; reason: string } {
  const skills = (state as any).skills as SkillState | undefined
  if (!skills) return { ok: false, reason: 'Skills system not initialized.' }

  const def = SKILLS_BY_ID[id]
  if (!def) return { ok: false, reason: 'Unknown skill.' }

  const rank = getSkillRank(state, id)
  if (rank >= def.maxRank) return { ok: false, reason: 'Max rank reached.' }
  if (skills.skillPoints <= 0) return { ok: false, reason: 'Not enough skill points.' }

  if (def.tier === 1 && rank <= 0) {
    const t1 = branchTier1UnlockedCount(state, def.branch)
    if (t1 >= TIER1_MAX_UNLOCKS_PER_BRANCH) {
      return {
        ok: false,
        reason: `Tier 1 cap reached (${TIER1_MAX_UNLOCKS_PER_BRANCH}/${TIER1_MAX_UNLOCKS_PER_BRANCH}) in ${def.branch}. Upgrade existing Tier 1 skills or unlock higher tiers.`,
      }
    }
  }

  const spentInBranch = branchSpentCount(state, def.branch)
  const needed = tierRequirementCount(def.tier)
  if (spentInBranch < needed) return { ok: false, reason: `Requires ${needed} skills in ${def.branch} to unlock Tier ${def.tier}.` }

  if (def.requires && def.requires.length > 0) {
    for (const req of def.requires) {
      const needRank = Math.max(1, Math.floor(req.rank ?? 1))
      const have = getSkillRank(state, req.id)
      if (have < needRank) {
        const nm = SKILLS_BY_ID[req.id]?.name ?? req.id
        return { ok: false, reason: `Requires ${nm} (rank ${needRank}).` }
      }
    }
  }

  return { ok: true }
}

export function xpToNext(level: number): number {
  const L = Math.max(0, Math.floor(level))
  const raw = 100 + Math.pow(L, 1.35) * 60
  return Math.max(1, Math.floor(raw))
}

export function waveXpMultiplier(wave: number, cfg: GameConfig): number {
  const w = Math.max(1, Math.floor(wave))
  const sCfg = (cfg.progression as any).skills
  const k = typeof sCfg?.waveXpK === 'number' ? sCfg.waveXpK : 0.165
  const s = typeof sCfg?.waveXpS === 'number' ? sCfg.waveXpS : 0.1
  const x = Math.max(0, w - 1)
  const mult = 1 + (k * x) / (1 + s * x)
  return clamp(mult, 1, 10)
}

export function baseXpPerWave(cfg: GameConfig): number {
  const sCfg = (cfg.progression as any).skills
  const base = typeof sCfg?.baseXP === 'number' && Number.isFinite(sCfg.baseXP) ? sCfg.baseXP : 22
  return Math.max(1, Math.floor(base))
}

export function calcWaveXpGain(wave: number, cfg: GameConfig): { baseXP: number; mult: number; gain: number } {
  const base = baseXpPerWave(cfg)
  const mult = waveXpMultiplier(wave, cfg)
  const gain = Math.max(0, Math.floor(base * mult))
  return { baseXP: base, mult, gain }
}

export type SkillPassives = {
  dmgMult: number
  fireRateBonus: number
  armorPierceBonus: number
  rangeMult: number
  shotCountBonus: number
  baseHPMult: number
  escapeDamageTakenMult: number
  rewardGoldMult: number
  rewardPointsMult: number
  shopGoldCostMult: number
  critChanceAdd: number
  critMultAdd: number
  xpGainMult: number
  cooldownMult: number
  repairPctMult: number
}

export function aggregateSkillPassives(state: GameState): SkillPassives {
  let dmgPct = 0
  let fireRatePct = 0
  let armorPierce = 0
  let rangePct = 0
  let shotBonus = 0
  let hpPct = 0
  let escapeDmgTakenPct = 0
  let goldPct = 0
  let pointsPct = 0
  let shopDiscountPct = 0
  let critChance = 0
  let critMult = 0
  let xpPct = 0
  let cooldownDiscountPct = 0
  let repairPct = 0

  for (const def of SKILLS) {
    const r = getSkillRank(state, def.id)
    if (r <= 0) continue
    const e = def.effects
    if (!e) continue
    dmgPct += (e.dmgPct ?? 0) * r
    fireRatePct += (e.fireRatePct ?? 0) * r
    armorPierce += (e.armorPierce ?? 0) * r
    rangePct += (e.rangePct ?? 0) * r
    shotBonus += (e.shotBonus ?? 0) * r
    hpPct += (e.hpPct ?? 0) * r
    escapeDmgTakenPct += (e.escapeDmgTakenPct ?? 0) * r
    goldPct += (e.goldPct ?? 0) * r
    pointsPct += (e.pointsPct ?? 0) * r
    shopDiscountPct += (e.shopDiscountPct ?? 0) * r
    critChance += (e.critChance ?? 0) * r
    critMult += (e.critMult ?? 0) * r
    xpPct += (e.xpPct ?? 0) * r
    cooldownDiscountPct += (e.cooldownDiscountPct ?? 0) * r
    repairPct += (e.repairPct ?? 0) * r
  }

  const dmgMult = clamp(1 + dmgPct, 0.2, 6)
  const fireRateBonus = clamp(fireRatePct, -0.5, 3)
  const armorPierceBonus = clamp(armorPierce, 0, 2)
  const rangeMult = clamp(1 + rangePct, 0.7, 2)
  const shotCountBonus = clamp(Math.floor(shotBonus), 0, 4)

  const baseHPMult = clamp(1 + hpPct, 0.3, 6)
  const escapeDamageTakenMult = clamp(1 + escapeDmgTakenPct, 0.3, 2.5)

  const rewardGoldMult = clamp(1 + goldPct, 0.2, 6)
  const rewardPointsMult = clamp(1 + pointsPct, 0.2, 6)
  const shopGoldCostMult = clamp(1 - shopDiscountPct, 0.6, 1.2)

  const critChanceAdd = clamp(critChance, 0, 0.95)
  const critMultAdd = clamp(critMult, 0, 4)

  const xpGainMult = clamp(1 + xpPct, 0.2, 6)

  const cooldownMult = clamp(1 - cooldownDiscountPct, 0.6, 1.2)

  const repairPctMult = clamp(1 + repairPct, 0.2, 6)

  return {
    dmgMult,
    fireRateBonus,
    armorPierceBonus,
    rangeMult,
    shotCountBonus,
    baseHPMult,
    escapeDamageTakenMult,
    rewardGoldMult,
    rewardPointsMult,
    shopGoldCostMult,
    critChanceAdd,
    critMultAdd,
    xpGainMult,
    cooldownMult,
    repairPctMult,
  }
}
