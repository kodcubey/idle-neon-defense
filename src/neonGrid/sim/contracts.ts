import type { GameConfig, GameState, WaveReport } from '../types'
import { dayIndexUTC } from './deterministic'

export type DailyContractsState = {
  day: number
  maxWaveCompleted: number
  krStreak: number
  bestKrStreak: number
  pointsEarned: number
  claimed: Record<string, boolean>
}

export type DailyContractView = {
  id: string
  titleTR: string
  titleEN: string
  descTR: string
  descEN: string
  progress: number
  goal: number
  rewardPoints: number
  completed: boolean
  claimed: boolean
}

function clampInt(v: number, min: number, max: number): number {
  const n = Number.isFinite(v) ? Math.floor(v) : 0
  return Math.max(min, Math.min(max, n))
}

export function defaultDailyContractsState(nowUTC: number): DailyContractsState {
  const day = dayIndexUTC(nowUTC)
  return {
    day,
    maxWaveCompleted: 0,
    krStreak: 0,
    bestKrStreak: 0,
    pointsEarned: 0,
    claimed: {},
  }
}

export function ensureDailyContractsState(state: GameState, nowUTC: number): GameState {
  const today = dayIndexUTC(nowUTC)
  const cur = (state as any).dailyContracts as DailyContractsState | undefined

  if (!cur || typeof cur !== 'object' || cur.day !== today) {
    return { ...state, dailyContracts: defaultDailyContractsState(nowUTC) } as GameState
  }

  const claimedIn = cur.claimed && typeof cur.claimed === 'object' ? cur.claimed : {}
  const claimed: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(claimedIn)) claimed[k] = !!v

  const fixed: DailyContractsState = {
    day: today,
    maxWaveCompleted: clampInt(cur.maxWaveCompleted, 0, 10_000),
    krStreak: clampInt(cur.krStreak, 0, 10_000),
    bestKrStreak: clampInt(cur.bestKrStreak, 0, 10_000),
    pointsEarned: clampInt(cur.pointsEarned, 0, 1_000_000_000),
    claimed,
  }

  if (
    fixed.maxWaveCompleted !== cur.maxWaveCompleted ||
    fixed.krStreak !== cur.krStreak ||
    fixed.bestKrStreak !== cur.bestKrStreak ||
    fixed.pointsEarned !== cur.pointsEarned ||
    fixed.day !== cur.day
  ) {
    return { ...state, dailyContracts: fixed } as GameState
  }

  // Reattach a sanitized claimed map to avoid proto pollution.
  if (fixed.claimed !== cur.claimed) return { ...state, dailyContracts: fixed } as GameState
  return state
}

type ContractMetric = 'maxWaveCompleted' | 'bestKrStreak' | 'pointsEarned'

type ContractTemplate = {
  id: string
  metric: ContractMetric
  goal: (day: number, state: GameState, cfg: GameConfig) => number
  rewardPoints: (goal: number, day: number, state: GameState, cfg: GameConfig) => number
  titleTR: string
  titleEN: string
  descTR: (goal: number) => string
  descEN: (goal: number) => string
}

const CONTRACT_POOL: ContractTemplate[] = [
  {
    id: 'CT_REACH_WAVE_A',
    metric: 'maxWaveCompleted',
    goal: (day, _state) => 10 + (day % 8),
    rewardPoints: (goal) => clampInt(Math.round(goal * 1.4), 12, 60),
    titleTR: 'Dalga Koşusu',
    titleEN: 'Wave Runner',
    descTR: (goal) => `Bugün ${goal}. dalgayı tamamla.`,
    descEN: (goal) => `Complete wave ${goal} today.`,
  },
  {
    id: 'CT_REACH_WAVE_B',
    metric: 'maxWaveCompleted',
    goal: (day, state) => clampInt(6 + (day % 6) + Math.floor((state.stats?.bestWave ?? 1) * 0.1), 6, 40),
    rewardPoints: (goal) => clampInt(10 + Math.round(goal * 1.2), 12, 70),
    titleTR: 'İlerleme Protokolü',
    titleEN: 'Progress Protocol',
    descTR: (goal) => `Bugün ${goal}. dalgaya ulaş.`,
    descEN: (goal) => `Reach wave ${goal} today.`,
  },
  {
    id: 'CT_KR_STREAK_A',
    metric: 'bestKrStreak',
    goal: (day) => 2 + (day % 4),
    rewardPoints: (goal) => clampInt(12 + goal * 10, 20, 80),
    titleTR: 'Temiz İcra',
    titleEN: 'Clean Execution',
    descTR: (goal) => `KR hedefini arka arkaya ${goal} dalga tuttur.`,
    descEN: (goal) => `Meet the KR target for ${goal} waves in a row.`,
  },
  {
    id: 'CT_KR_STREAK_B',
    metric: 'bestKrStreak',
    goal: (day, _state, cfg) => clampInt(2 + (day % 3) + Math.floor(cfg.sim.waveDurationSec / 30), 2, 6),
    rewardPoints: (goal) => clampInt(18 + goal * 9, 20, 90),
    titleTR: 'Disiplin',
    titleEN: 'Discipline',
    descTR: (goal) => `KR hedefini ${goal} dalga seri yakala.`,
    descEN: (goal) => `Get a ${goal}-wave KR streak.`,
  },
  {
    id: 'CT_EARN_PALADYUM_A',
    metric: 'pointsEarned',
    goal: (day) => 18 + 6 * (day % 6),
    rewardPoints: (goal) => clampInt(12 + Math.round(goal * 0.6), 16, 80),
    titleTR: 'Paladyum Vardiyası',
    titleEN: 'Paladyum Shift',
    descTR: (goal) => `Bugün toplam ${goal} Paladyum kazan.`,
    descEN: (goal) => `Earn ${goal} Paladyum today.`,
  },
  {
    id: 'CT_EARN_PALADYUM_B',
    metric: 'pointsEarned',
    goal: (day, state) => {
      const bw = clampInt(state.stats?.bestWave ?? 1, 1, 200)
      return clampInt(12 + (day % 5) * 8 + Math.floor(bw * 0.2), 12, 120)
    },
    rewardPoints: (goal) => clampInt(16 + Math.round(goal * 0.5), 18, 90),
    titleTR: 'Meta Akışı',
    titleEN: 'Meta Flow',
    descTR: (goal) => `Bugün ${goal} Paladyum topla.`,
    descEN: (goal) => `Collect ${goal} Paladyum today.`,
  },
]

function pickTodaysTemplates(day: number): ContractTemplate[] {
  const pool = CONTRACT_POOL
  const want = 3
  const start = ((day % pool.length) + pool.length) % pool.length
  const picked: ContractTemplate[] = []
  let cursor = start
  while (picked.length < want) {
    const t = pool[cursor % pool.length]
    if (!picked.some((p) => p.id === t.id)) picked.push(t)
    cursor++
    if (cursor - start > pool.length + 2) break
  }
  return picked
}

function metricProgress(daily: DailyContractsState, metric: ContractMetric): number {
  if (metric === 'maxWaveCompleted') return daily.maxWaveCompleted
  if (metric === 'bestKrStreak') return daily.bestKrStreak
  return daily.pointsEarned
}

export function getDailyContracts(args: {
  state: GameState
  config: GameConfig
  nowUTC: number
}): { state: GameState; day: number; contracts: DailyContractView[] } {
  const state0 = ensureDailyContractsState(args.state, args.nowUTC)
  const daily = (state0 as any).dailyContracts as DailyContractsState
  const day = daily.day

  const templates = pickTodaysTemplates(day)
  const contracts: DailyContractView[] = templates.map((t) => {
    const goal = clampInt(t.goal(day, state0, args.config), 1, 1_000_000_000)
    const rewardPoints = clampInt(t.rewardPoints(goal, day, state0, args.config), 0, 1_000_000_000)
    const progress = clampInt(metricProgress(daily, t.metric), 0, 1_000_000_000)
    const completed = progress >= goal
    const claimed = !!daily.claimed?.[t.id]
    return {
      id: t.id,
      titleTR: t.titleTR,
      titleEN: t.titleEN,
      descTR: t.descTR(goal),
      descEN: t.descEN(goal),
      progress,
      goal,
      rewardPoints,
      completed,
      claimed,
    }
  })

  return { state: state0, day, contracts }
}

export function applyWaveCompleteToDailyContracts(args: {
  state: GameState
  report: WaveReport
  config: GameConfig
  nowUTC: number
}): GameState {
  const state0 = ensureDailyContractsState(args.state, args.nowUTC)
  const cur = (state0 as any).dailyContracts as DailyContractsState

  const maxWaveCompleted = Math.max(clampInt(cur.maxWaveCompleted, 0, 10_000), clampInt(args.report.wave, 0, 10_000))

  const metKR = args.report.killRatio + 1e-9 >= args.report.threshold
  const nextStreak = metKR ? clampInt(cur.krStreak + 1, 0, 10_000) : 0
  const bestKrStreak = Math.max(clampInt(cur.bestKrStreak, 0, 10_000), nextStreak)

  const pointsEarned = clampInt(cur.pointsEarned + clampInt(args.report.rewardPoints, 0, 1_000_000_000), 0, 1_000_000_000)

  const dailyNext: DailyContractsState = {
    ...cur,
    maxWaveCompleted,
    krStreak: nextStreak,
    bestKrStreak,
    pointsEarned,
  }

  return { ...state0, dailyContracts: dailyNext } as GameState
}

export function claimDailyContract(args: {
  state: GameState
  config: GameConfig
  nowUTC: number
  contractId: string
}): { state: GameState; claimed: boolean; rewardPoints: number } {
  const info = getDailyContracts({ state: args.state, config: args.config, nowUTC: args.nowUTC })
  const state0 = info.state
  const daily = (state0 as any).dailyContracts as DailyContractsState

  const contract = info.contracts.find((c) => c.id === args.contractId)
  if (!contract) return { state: state0, claimed: false, rewardPoints: 0 }
  if (!contract.completed) return { state: state0, claimed: false, rewardPoints: 0 }
  if (daily.claimed?.[contract.id]) return { state: state0, claimed: false, rewardPoints: 0 }

  const claimed = { ...(daily.claimed ?? {}) }
  claimed[contract.id] = true

  const rewardPoints = clampInt(contract.rewardPoints, 0, 1_000_000_000)
  const next: GameState = {
    ...state0,
    points: clampInt((state0.points ?? 0) + rewardPoints, 0, 1_000_000_000_000),
    dailyContracts: {
      ...daily,
      claimed,
    },
  } as GameState

  return { state: next, claimed: true, rewardPoints }
}

export function mergeDailyContracts(local?: DailyContractsState, incoming?: DailyContractsState): DailyContractsState | undefined {
  if (!incoming || typeof incoming !== 'object') return local
  if (!local || typeof local !== 'object') return incoming

  const ld = clampInt(local.day, 0, 1_000_000_000)
  const id = clampInt(incoming.day, 0, 1_000_000_000)

  // Prefer the newer day. If same day, merge monotonically.
  if (id > ld) return incoming
  if (ld > id) return local

  const claimed: Record<string, boolean> = { ...(local.claimed ?? {}) }
  for (const [k, v] of Object.entries(incoming.claimed ?? {})) claimed[k] = claimed[k] || !!v

  return {
    day: ld,
    maxWaveCompleted: Math.max(clampInt(local.maxWaveCompleted, 0, 10_000), clampInt(incoming.maxWaveCompleted, 0, 10_000)),
    krStreak: Math.max(clampInt(local.krStreak, 0, 10_000), clampInt(incoming.krStreak, 0, 10_000)),
    bestKrStreak: Math.max(clampInt(local.bestKrStreak, 0, 10_000), clampInt(incoming.bestKrStreak, 0, 10_000)),
    pointsEarned: Math.max(clampInt(local.pointsEarned, 0, 1_000_000_000), clampInt(incoming.pointsEarned, 0, 1_000_000_000)),
    claimed,
  }
}
