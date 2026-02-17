import type { GameState, SkillCardId, SkillCardSlot } from '../types'

export type SkillCardDef = {
  id: SkillCardId
  name: string
  description: string
  tone: 'cyan' | 'magenta' | 'lime'
  icon: string
}

export const SKILL_CARDS: SkillCardDef[] = [
  {
    id: 'SC_LIGHTNING_ARC',
    name: 'Lightning Arc',
    description: 'Periodically zaps the lead target and chains to a second enemy.',
    tone: 'cyan',
    icon: '⚡',
  },
  {
    id: 'SC_UZI_SPRAY',
    name: 'UZI Spray',
    description: 'High-rate bullet spray: more shots, lighter hits, very visible trails.',
    tone: 'magenta',
    icon: '✦',
  },
  {
    id: 'SC_SPIN_SWORD',
    name: 'Orbiting Sword',
    description: 'A spinning blade ring damages enemies that get close to the base.',
    tone: 'lime',
    icon: '⟲',
  },
  {
    id: 'SC_WALL_FIELD',
    name: 'Wall Field',
    description: 'A neon barrier ring periodically stops enemies that cross it.',
    tone: 'cyan',
    icon: '▣',
  },
  {
    id: 'SC_LASER_BEAM',
    name: 'Laser Beam',
    description: 'A continuous beam burns the lead target (with a persistent beam visual).',
    tone: 'magenta',
    icon: '━',
  },
  {
    id: 'SC_MINE_GRID',
    name: 'Mine Grid',
    description: 'Drops mines that arm then explode in a bright AoE pulse.',
    tone: 'lime',
    icon: '●',
  },
  {
    id: 'SC_FREEZE_PULSE',
    name: 'Freeze Pulse',
    description: 'Emits a pulse that slows enemies for a short duration (big ring effect).',
    tone: 'cyan',
    icon: '◌',
  },
  {
    id: 'SC_DRONE_GUNNER',
    name: 'Drone Gunner',
    description: 'A small drone orbits and fires extra shots from its position.',
    tone: 'magenta',
    icon: '⬟',
  },
  {
    id: 'SC_RICOCHET',
    name: 'Ricochet',
    description: 'Shots bounce once to a second target (extra visible impact chains).',
    tone: 'lime',
    icon: '↷',
  },
  {
    id: 'SC_SHIELD_DOME',
    name: 'Shield Dome',
    description: 'A protective dome reduces escape damage taken (visible shield ring).',
    tone: 'cyan',
    icon: '◠',
  },
]

const CARD_ID_SET = new Set<SkillCardId>(SKILL_CARDS.map((c) => c.id))

export function isSkillCardId(id: unknown): id is SkillCardId {
  return typeof id === 'string' && CARD_ID_SET.has(id as SkillCardId)
}

export function getEquippedSkillCards(state: GameState): SkillCardId[] {
  const eq = (state as any).skillCardsEquipped as Record<number, SkillCardId | null> | undefined
  if (!eq || typeof eq !== 'object') return []
  const out: SkillCardId[] = []
  for (const slot of [1, 2, 3] as SkillCardSlot[]) {
    const id = eq[slot]
    if (id && isSkillCardId(id)) out.push(id)
  }
  return out
}
