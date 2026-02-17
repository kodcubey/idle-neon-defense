import type { GameConfig, GameState, RunSummary, SkillCardId, WaveReport, WaveSnapshot } from '../types'
import {
  aggregateModules,
  baseDmg,
  calcPenaltyFactor,
  calcEnemyStats,
  calcSpawnTimeSec,
  calcWaveReport,
  calcWaveSnapshot,
  clamp,
  effectiveCritParamsCached,
  effectiveEnemySpeedMult,
  fireRate,
  towerMultiShotCount,
  towerArmorPierceBonus,
  towerEscapeDamageMult,
  towerRepairPctPerSec,
  towerRange,
} from './deterministic'
import { calcBaseHPMax } from './actions'
import { aggregateSkillPassives, calcWaveXpGain, getSkillRank, xpToNext } from '../skills/skills'
import { labEffectMult } from '../labs/labs'
import { getEquippedSkillCards } from '../skills/skillCards.ts'
import type { Vec2 } from './path'

export type CardFx =
  | { id: number; kind: 'LIGHTNING_ARC'; x0: number; y0: number; x1: number; y1: number }
  | { id: number; kind: 'RICOCHET'; x0: number; y0: number; x1: number; y1: number }
  | { id: number; kind: 'MINE_BLAST'; x: number; y: number; r: number }
  | { id: number; kind: 'FREEZE_PULSE'; x: number; y: number; r: number }
  | { id: number; kind: 'WALL_PULSE'; x: number; y: number; r: number }

type CardFxEvent = CardFx extends infer U ? (U extends any ? Omit<U, 'id'> : never) : never

export type ProjectileKind = 'BOLT' | 'UZI' | 'DRONE'

export type EnemyEntity = {
  id: number
  index1: number
  typeId: string
  color: string
  maxHP: number
  hp: number
  armor: number
  speed: number // units/sec
  x: number
  y: number
  vx: number
  vy: number
  spawnedAtSec: number
  alive: boolean
  slowUntilSec?: number
  slowMult?: number
}

export type ProjectileEntity = {
  id: number
  x: number
  y: number
  speed: number
  targetEnemyId: number
  damageMult: number
  alive: boolean
  kind: ProjectileKind
  bouncesLeft: number
}

export type SimPublic = {
  state: GameState
  wave: WaveSnapshot
  waveTimeSec: number
  killed: number
  escaped: number
  spawnedSoFar: number
  timeScale: 1 | 2 | 3
  paused: boolean
  enemies: ReadonlyArray<EnemyEntity>
  projectiles: ReadonlyArray<ProjectileEntity>
  cardFx?: ReadonlyArray<CardFx>
  skillsRuntime?: {
    comboStacks: number
    adrenalActive: boolean
    tacticalActive: boolean
    guardChargeReady: boolean
    aegisCharge: number
    lastProc?: 'GUARD_BLOCK' | 'AEGIS_BLOCK' | 'SECOND_BREATH' | 'EMERGENCY_KIT' | 'RECOVERY_PULSE'
    lastProcUntilSec?: number
  }
  arena: {
    center: Vec2
    bounds: { left: number; top: number; right: number; bottom: number }
    maxSpawnDist: number
    baseHalfSize: number
  }
  tower: {
    pos: Vec2
    range: number
    armorPierce: number
    damagePerShot: number
    fireRate: number
  }
}

export type SimCallbacks = {
  onWaveComplete: (report: WaveReport) => void
  onStateChanged: (state: GameState) => void
  onGameOver: (runSummary: RunSummary) => void
}

type SpawnPlan = {
  index1: number
  spawnAtSec: number
  hp: number
  armor: number
  speed: number
  typeId: string
  color: string
  x: number
  y: number
  vx: number
  vy: number
}

export class SimEngine {
  private cfg: GameConfig
  private cb: SimCallbacks

  private _state: GameState
  private snapshot: WaveSnapshot
  private waveMods!: ReturnType<typeof aggregateModules>

  private waveTimeSec = 0
  private killed = 0
  private escaped = 0
  private spawnedSoFar = 0
  private escapeDamageAppliedThisWave = 0

  private nextEnemyId = 1
  private nextProjectileId = 1
  private spawnPlan: SpawnPlan[] = []
  private spawnCursor = 0

  private enemies: EnemyEntity[] = []
  private projectiles: ProjectileEntity[] = []

  private paused = false
  private timeScale: 1 | 2 | 3 = 2
  private awaitingNextWave = false

  private modsCache: ReturnType<typeof aggregateModules> | null = null
  private skillsCache: ReturnType<typeof aggregateSkillPassives> | null = null
  private modsDirty = true
  private skillsDirty = true

  private towerPos: Vec2 = { x: 0, y: 0 }
  private towerCooldown = 0
  private towerShotCounter = 0

  private invulnRemainingSec = 0
  private invulnCooldownRemainingSec = 0

  // --- Skill Cards runtime (deterministic; no RNG) ---
  private cardFx: CardFx[] = []
  private nextCardFxId = 1
  private lightningCooldown = 0
  private laserTickCooldown = 0
  private swordTickCooldown = 0
  private wallPulseCooldown = 0
  private freezePulseCooldown = 0
  private mineCooldown = 0

  // --- Skills runtime (deterministic; no RNG) ---
  private comboStacks = 0
  private adrenalRemainingSec = 0
  private tacticalRemainingSec = 0
  private guardRechargeRemainingSec = 0
  private aegisCharge = 0
  private emergencyKitUsedThisWave = false
  private lastProc: 'GUARD_BLOCK' | 'AEGIS_BLOCK' | 'SECOND_BREATH' | 'EMERGENCY_KIT' | 'RECOVERY_PULSE' | undefined = undefined
  private lastProcUntilSec: number | undefined = undefined

  private arena: {
    center: Vec2
    bounds: { left: number; top: number; right: number; bottom: number }
    maxSpawnDist: number
    baseHalfSize: number
  }

  private viewport: { width: number; height: number }

  constructor(args: { initialState: GameState; config: GameConfig; callbacks: SimCallbacks; viewport: { width: number; height: number } }) {
    this.cfg = args.config
    this.cb = args.callbacks
    this._state = { ...args.initialState }

    this.viewport = { ...args.viewport }

    this.arena = this.createArena(args.viewport)
    this.towerPos = { ...this.arena.center }

    this.waveMods = aggregateModules(this._state, this.cfg)
    this.modsCache = this.waveMods
    this.modsDirty = false
    this.skillsDirty = true
    this.snapshot = calcWaveSnapshot(this._state, this.cfg)
    this.buildSpawnPlan()

    // Ensure wave-start skills apply on the initial wave.
    this.onWaveStart(false)
  }

  private onWaveStart(decrementWaveCooldowns: boolean) {
    if (!this._state.skills) return

    if (decrementWaveCooldowns) {
      // Decrement wave-based cooldowns at the start of each *new* wave.
      this._state.skills.cooldowns.secondBreathWaves = Math.max(0, Math.floor(this._state.skills.cooldowns.secondBreathWaves ?? 0) - 1)
      this._state.skills.cooldowns.emergencyKitWaves = Math.max(0, Math.floor(this._state.skills.cooldowns.emergencyKitWaves ?? 0) - 1)
    }

    this.comboStacks = 0
    this.emergencyKitUsedThisWave = false
    this.lastProc = undefined
    this.lastProcUntilSec = undefined

    // Wave-start abilities.
    if (getSkillRank(this._state, 'AT_ADRENAL_BURST') > 0) this.adrenalRemainingSec = 8
    else this.adrenalRemainingSec = 0

    if (getSkillRank(this._state, 'UT_TACTICAL_RELAY') > 0) this.tacticalRemainingSec = 6
    else this.tacticalRemainingSec = 0

    const aegis = getSkillRank(this._state, 'DF_AEGIS_PROTOCOL')
    const reserve = getSkillRank(this._state, 'DF_AEGIS_RESERVE')
    this.aegisCharge = aegis > 0 ? 1 + (reserve > 0 ? 1 : 0) : 0

    if (getSkillRank(this._state, 'DF_GUARD_STEP') > 0) {
      // Start each wave with a ready charge.
      this.guardRechargeRemainingSec = 0
    }

    // Wave Barrier: small wave-start heal.
    if (getSkillRank(this._state, 'DF_WAVE_BARRIER') > 0) {
      const maxHP = calcBaseHPMax(this._state, this.cfg)
      this._state.baseHP = clamp(this._state.baseHP + 0.03 * maxHP, 0, maxHP)
    }
  }

  private getModsCached() {
    if (!this.modsDirty && this.modsCache) return this.modsCache
    this.modsCache = aggregateModules(this._state, this.cfg)
    this.modsDirty = false
    return this.modsCache
  }

  private getSkillsCached() {
    if (!this.skillsDirty && this.skillsCache) return this.skillsCache
    this.skillsCache = aggregateSkillPassives(this._state)
    this.skillsDirty = false
    return this.skillsCache
  }

  getPublic(): SimPublic {
    const mods = this.getModsCached()
    const skills = this.getSkillsCached()

    const dmgLabMult = labEffectMult((this._state as any).lab?.levels?.damage ?? 0)
    const frLabMult = labEffectMult((this._state as any).lab?.levels?.fireRate ?? 0)
    const rangeLabMult = labEffectMult((this._state as any).lab?.levels?.range ?? 0)

    const damagePerShot =
      ((baseDmg(this._state.towerUpgrades.damageLevel, this.cfg, dmgLabMult) * mods.dmgMult + mods.dmgFlat) * skills.dmgMult) *
      (1 + 0) *
      (1 + 0) *
      (1 + 0) *
      (1 + 0)

    const adrenalMult = this.adrenalRemainingSec > 0 ? 1.1 : 1
    const fr =
      fireRate(this._state.towerUpgrades.fireRateLevel, this.cfg, frLabMult) * (1 + mods.fireRateBonus) * (1 + skills.fireRateBonus) * adrenalMult

    const tacticalMult = this.tacticalRemainingSec > 0 ? 1.1 : 1
    const range = (towerRange(this._state.towerUpgrades.rangeLevel, this.cfg, rangeLabMult) + mods.rangeBonus) * tacticalMult * skills.rangeMult
    const armorPierce = clamp(mods.armorPierce + towerArmorPierceBonus(this._state, this.cfg) + skills.armorPierceBonus, 0, 0.9)

    const guardRank = getSkillRank(this._state, 'DF_GUARD_STEP')
    const procAlive = typeof this.lastProcUntilSec === 'number' ? this.waveTimeSec <= this.lastProcUntilSec : false

    return {
      state: this._state,
      wave: this.snapshot,
      waveTimeSec: this.waveTimeSec,
      killed: this.killed,
      escaped: this.escaped,
      spawnedSoFar: this.spawnedSoFar,
      timeScale: this.timeScale,
      paused: this.paused,
      enemies: this.enemies,
      projectiles: this.projectiles,
      cardFx: this.cardFx,
      skillsRuntime: {
        comboStacks: this.comboStacks,
        adrenalActive: this.adrenalRemainingSec > 0,
        tacticalActive: this.tacticalRemainingSec > 0,
        guardChargeReady: guardRank > 0 && this.guardRechargeRemainingSec <= 0,
        aegisCharge: this.aegisCharge,
        lastProc: procAlive ? this.lastProc : undefined,
        lastProcUntilSec: procAlive ? this.lastProcUntilSec : undefined,
      },
      arena: {
        center: this.arena.center,
        bounds: this.arena.bounds,
        maxSpawnDist: this.arena.maxSpawnDist,
        baseHalfSize: this.arena.baseHalfSize,
      },
      tower: {
        pos: this.towerPos,
        range,
        armorPierce,
        damagePerShot,
        fireRate: fr,
      },
    }
  }

  getSnapshot(): GameState {
    return { ...this._state }
  }

  // Apply player-state changes (upgrades, settings, module changes) without
  // resetting the current wave runtime. This preserves enemies/projectiles and
  // keeps the wave snapshot fixed for determinism.
  applyStateSoft(state: GameState) {
    // If wave changed, fall back to a full reset.
    if (Math.floor(state.wave) !== Math.floor(this._state.wave)) {
      this.setSnapshot(state)
      return
    }

    this._state = { ...state }
    this.modsDirty = true
    this.skillsDirty = true
    // Do NOT recompute snapshot, wave time, spawn plan, or runtime counters.
    this.cb.onStateChanged(this._state)
  }

  setSnapshot(state: GameState) {
    this._state = { ...state }
    this.waveMods = aggregateModules(this._state, this.cfg)
    this.modsCache = this.waveMods
    this.modsDirty = false
    this.skillsDirty = true
    this.snapshot = calcWaveSnapshot(this._state, this.cfg)
    this.resetWaveRuntime()
    this.buildSpawnPlan()
    this.onWaveStart(false)
    this.awaitingNextWave = false
    this.cb.onStateChanged(this._state)
  }

  setViewport(viewport: { width: number; height: number }) {
    const next = {
      width: Math.max(1, viewport.width),
      height: Math.max(1, viewport.height),
    }

    const prev = this.viewport
    this.viewport = next

    const sx = prev.width > 0 ? next.width / prev.width : 1
    const sy = prev.height > 0 ? next.height / prev.height : 1

    // Recompute arena based on new viewport.
    this.arena = this.createArena(next)
    this.towerPos = { ...this.arena.center }

    // Rescale existing runtime entities into the new coordinate space so they
    // don't drift away from the tower/base after a resize.
    if (sx !== 1 || sy !== 1) {
      for (const e of this.enemies) {
        e.x *= sx
        e.y *= sy
      }
      for (const p of this.projectiles) {
        p.x *= sx
        p.y *= sy
      }
    }

    // Retarget enemy velocities toward the (possibly moved) base center.
    // Enemies store velocity, not a steering target; without this, a resize can
    // make them head toward the old center and look "random".
    for (const e of this.enemies) {
      if (!e.alive) continue
      const dx = this.arena.center.x - e.x
      const dy = this.arena.center.y - e.y
      const dist = Math.hypot(dx, dy)
      const inv = dist <= 1e-6 ? 0 : 1 / dist
      e.vx = dx * inv * e.speed
      e.vy = dy * inv * e.speed
    }

    // Spawn plan depends on arena bounds/center. Rebuild it and advance the
    // cursor to the first spawn after the current wave time.
    this.buildSpawnPlan()
    let cursor = 0
    while (cursor < this.spawnPlan.length && this.spawnPlan[cursor].spawnAtSec <= this.waveTimeSec) cursor++
    this.spawnCursor = cursor
    this.spawnedSoFar = cursor
  }

  setPaused(p: boolean) {
    this.paused = p
  }

  isPaused() {
    return this.paused
  }

  startNextWave() {
    if (!this.awaitingNextWave) return
    this.awaitingNextWave = false

    this._state.wave++
    this._state.stats.bestWave = Math.max(this._state.stats.bestWave, this._state.wave)

    this.waveMods = aggregateModules(this._state, this.cfg)
    this.modsCache = this.waveMods
    this.modsDirty = false
    this.skillsDirty = true
    this.snapshot = calcWaveSnapshot(this._state, this.cfg)
    this.resetWaveRuntime()
    this.buildSpawnPlan()

    this.onWaveStart(true)

    this.paused = false
    this.cb.onStateChanged(this._state)
  }

  setTimeScale(scale: 1 | 2 | 3) {
    this.timeScale = scale
  }

  tick(dtSec: number) {
    if (this.paused) return

    // Clear per-tick FX events.
    this.cardFx.length = 0

    const scaled = dtSec * this.timeScale

    // Skill Cards cooldowns (deterministic; time-based).
    this.lightningCooldown = Math.max(0, this.lightningCooldown - scaled)
    this.laserTickCooldown = Math.max(0, this.laserTickCooldown - scaled)
    this.swordTickCooldown = Math.max(0, this.swordTickCooldown - scaled)
    this.wallPulseCooldown = Math.max(0, this.wallPulseCooldown - scaled)
    this.freezePulseCooldown = Math.max(0, this.freezePulseCooldown - scaled)
    this.mineCooldown = Math.max(0, this.mineCooldown - scaled)

    // Utility abilities (deterministic; time-based).
    this.invulnRemainingSec = Math.max(0, this.invulnRemainingSec - scaled)
    this.invulnCooldownRemainingSec = Math.max(0, this.invulnCooldownRemainingSec - scaled)

    // Skills runtime timers (deterministic; time-based).
    this.adrenalRemainingSec = Math.max(0, this.adrenalRemainingSec - scaled)
    this.tacticalRemainingSec = Math.max(0, this.tacticalRemainingSec - scaled)
    this.guardRechargeRemainingSec = Math.max(0, this.guardRechargeRemainingSec - scaled)

    this.waveTimeSec += scaled
    this._state.stats.totalTimeSec += scaled

    // Defense: deterministic self-repair (regen) based on max HP.
    // Applied continuously while unpaused.
    this.applyTowerRepair(scaled)

    this.maybeTriggerEmergencyKit()

    this.maybeTriggerInvulnerability()

    this.spawnEnemiesUpToTime(this.waveTimeSec)
    this.stepEnemies(scaled)
    if (this.paused) {
      this.cb.onStateChanged(this._state)
      return
    }

    // Skill Cards (deterministic) - apply non-projectile effects.
    this.stepSkillCards()

    this.stepTower(scaled)
    this.stepProjectiles(scaled)

    const T = this.cfg.sim.waveDurationSec
    if (this.waveTimeSec >= T) {
      this.finishWave()
    }

    this.cb.onStateChanged(this._state)
  }

  private resetWaveRuntime() {
    this.waveTimeSec = 0
    this.killed = 0
    this.escaped = 0
    this.spawnedSoFar = 0
    this.escapeDamageAppliedThisWave = 0
    this.enemies = []
    this.projectiles = []
    this.spawnCursor = 0
    this.towerCooldown = 0
    this.invulnRemainingSec = 0
    this.invulnCooldownRemainingSec = 0

    this.cardFx = []
    this.nextCardFxId = 1
    this.lightningCooldown = 0
    this.laserTickCooldown = 0
    this.swordTickCooldown = 0
    this.wallPulseCooldown = 0
    this.freezePulseCooldown = 0
    this.mineCooldown = 0

    this.comboStacks = 0
    this.adrenalRemainingSec = 0
    this.tacticalRemainingSec = 0
    this.guardRechargeRemainingSec = 0
    this.aegisCharge = 0
    this.emergencyKitUsedThisWave = false
    this.lastProc = undefined
    this.lastProcUntilSec = undefined
  }

  private applyEscapeDamageNow(count: number) {
    if (!this.cfg.progression.enableEscapeDamage) return
    if (count <= 0) return
    if (this.invulnRemainingSec > 0) return

    const N = Math.max(1, this.snapshot.spawnCount)
    const killRatioNow = clamp(this.killed / N, 0, 1)
    const { deficit } = calcPenaltyFactor(killRatioNow, this.snapshot.threshold, this.cfg)

    const stabilityRank = getSkillRank(this._state, 'DF_STABILITY')
    const deficitBoostMult = clamp(1 - 0.15 * stabilityRank, 0, 1)
    const perEscape = this.cfg.progression.escapeDamage * (1 + this.cfg.progression.deficitBoost * deficit * deficitBoostMult)
    const afterFortify = perEscape * towerEscapeDamageMult(this._state, this.cfg, this.getSkillsCached())
    let dmg = Math.max(0, afterFortify * count)

    // Skill Card: Shield Dome reduces escape damage.
    if (this.hasCard('SC_SHIELD_DOME')) {
      dmg *= 0.75
    }

    // Aegis Protocol: blocks escape hits (first full, second partial if Aegis Reserve).
    if (getSkillRank(this._state, 'DF_AEGIS_PROTOCOL') > 0 && this.aegisCharge > 0) {
      const reserve = getSkillRank(this._state, 'DF_AEGIS_RESERVE') > 0
      const was = this.aegisCharge
      this.aegisCharge = Math.max(0, this.aegisCharge - 1)
      this.lastProc = 'AEGIS_BLOCK'
      this.lastProcUntilSec = this.waveTimeSec + 1.25

      // If no reserve: always full block. With reserve: first (was=2) full block, second (was=1) partial.
      if (!reserve || was >= 2) return
      dmg *= 0.4
    }

    // Guard Step: periodic single-hit shield.
    if (getSkillRank(this._state, 'DF_GUARD_STEP') > 0 && this.guardRechargeRemainingSec <= 0) {
      dmg *= 0.8
      const cdMult = this.getSkillsCached().cooldownMult
      this.guardRechargeRemainingSec = 10 * cdMult
      this.lastProc = 'GUARD_BLOCK'
      this.lastProcUntilSec = this.waveTimeSec + 1.25
    }

    this.escapeDamageAppliedThisWave += dmg
    this._state.baseHP = Math.max(0, this._state.baseHP - dmg)

    // Shock Absorbers: extra reduction when below 50% HP.
    if (this._state.baseHP > 0 && getSkillRank(this._state, 'DF_SHOCK_ABSORBERS') > 0) {
      const rank = getSkillRank(this._state, 'DF_SHOCK_ABSORBERS')
      const maxHP = calcBaseHPMax(this._state, this.cfg)
      if (maxHP > 0 && this._state.baseHP / maxHP <= 0.5) {
        // Apply as a refund-style heal to keep escape damage accounting consistent.
        const refund = dmg * clamp(0.05 * rank, 0, 0.2)
        this._state.baseHP = clamp(this._state.baseHP + refund, 0, maxHP)
      }
    }

    // Second Breath: once below 15% HP, heal and start wave cooldown.
    if (this._state.baseHP > 0 && getSkillRank(this._state, 'DF_SECOND_BREATH') > 0) {
      const cd = Math.max(0, Math.floor(this._state.skills?.cooldowns?.secondBreathWaves ?? 0))
      if (cd <= 0) {
        const maxHP = calcBaseHPMax(this._state, this.cfg)
        if (maxHP > 0 && this._state.baseHP / maxHP <= 0.15) {
          this._state.baseHP = clamp(this._state.baseHP + 0.1 * maxHP, 0, maxHP)
          const cdMult = this.getSkillsCached().cooldownMult
          this._state.skills.cooldowns.secondBreathWaves = Math.max(1, Math.ceil(3 * cdMult))
          this.lastProc = 'SECOND_BREATH'
          this.lastProcUntilSec = this.waveTimeSec + 1.5
        }
      }
    }

    if (this._state.baseHP <= 0) {
      const sum: RunSummary = {
        endedAtWave: this._state.wave,
        totalGoldThisRun: this._state.gold,
        totalTimeSec: this._state.stats.totalTimeSec,
      }
      this.cb.onGameOver(sum)
      this.paused = true
      this.awaitingNextWave = false
    }
  }

  private buildSpawnPlan() {
    this.spawnPlan = []
    const N = this.snapshot.spawnCount

    for (let i = 1; i <= N; i++) {
      const spawnAtSec = calcSpawnTimeSec(this.snapshot.wave, i, N, this.cfg)
      const s = calcEnemyStats(this.snapshot.wave, i, this.snapshot.totalEHP, N, this.cfg, this.waveMods)

      const spawn = this.calcSpawnPoint(this.snapshot.wave, i)
      const dx = this.arena.center.x - spawn.x
      const dy = this.arena.center.y - spawn.y
      const dist = Math.hypot(dx, dy)
      const inv = dist <= 1e-6 ? 0 : 1 / dist
      const vx = dx * inv * s.speed
      const vy = dy * inv * s.speed

      this.spawnPlan.push({
        index1: i,
        spawnAtSec,
        hp: s.hp,
        armor: s.armor,
        speed: s.speed,
        typeId: s.type.id,
        color: s.type.color,
        x: spawn.x,
        y: spawn.y,
        vx,
        vy,
      })
    }

    this.spawnPlan.sort((a, b) => a.spawnAtSec - b.spawnAtSec)
  }

  private spawnEnemiesUpToTime(nowSec: number) {
    while (this.spawnCursor < this.spawnPlan.length) {
      const plan = this.spawnPlan[this.spawnCursor]
      if (plan.spawnAtSec > nowSec) return

      const enemy: EnemyEntity = {
        id: this.nextEnemyId++,
        index1: plan.index1,
        typeId: plan.typeId,
        color: plan.color,
        maxHP: plan.hp,
        hp: plan.hp,
        armor: plan.armor,
        speed: plan.speed,
        x: plan.x,
        y: plan.y,
        vx: plan.vx,
        vy: plan.vy,
        spawnedAtSec: plan.spawnAtSec,
        alive: true,
      }

      this.enemies.push(enemy)
      this.spawnCursor++
      this.spawnedSoFar++
    }
  }

  private stepEnemies(dtSec: number) {
    const speedMult = effectiveEnemySpeedMult(this._state, this.cfg, this.getModsCached())
    for (const e of this.enemies) {
      if (!e.alive) continue

      const slowed = typeof e.slowUntilSec === 'number' && this.waveTimeSec <= e.slowUntilSec
      const slowMult = slowed ? clamp(e.slowMult ?? 1, 0.1, 1) : 1

      e.x += e.vx * dtSec * speedMult * slowMult
      e.y += e.vy * dtSec * speedMult * slowMult

      const dx = e.x - this.arena.center.x
      const dy = e.y - this.arena.center.y
      // Base zone is a circle (not a square) centered at arena center.
      if (dx * dx + dy * dy <= this.arena.baseHalfSize * this.arena.baseHalfSize) {
        e.alive = false
        this.escaped++
        this._state.stats.totalEscapes++

        // Apply escape damage immediately (deterministic; no RNG).
        this.applyEscapeDamageNow(1)
        if (this.paused) return
      }
    }

    // Compaction to keep perf stable.
    if (this.enemies.length > 800) this.enemies = this.enemies.filter((e) => e.alive)
  }

  private stepTower(dtSec: number) {
    this.towerCooldown = Math.max(0, this.towerCooldown - dtSec)
    if (this.towerCooldown > 0) return

    const pub = this.getPublic()
    const fireRateNow = Math.max(0.1, pub.tower.fireRate)
    const cd = 1 / fireRateNow

    const mods = this.getModsCached()
    const skills = this.getSkillsCached()
    const baseShots = towerMultiShotCount(this._state, this.cfg)
    const totalShots = Math.max(1, Math.floor(Math.max(baseShots, mods.shotCount) + Math.max(0, skills.shotCountBonus)))
    const targets = this.pickTargets(pub, totalShots)
    if (targets.length === 0) return

    const crit = effectiveCritParamsCached(this._state, this.cfg, mods, skills)

    // Spawn visible projectiles; damage is applied on impact.
    for (const t of targets) {
      let damageMult = 1
      if (Number.isFinite(crit.everyN) && crit.everyN !== Number.POSITIVE_INFINITY && crit.mult > 1.000001) {
        this.towerShotCounter++
        if (this.towerShotCounter % Math.max(1, Math.floor(crit.everyN)) === 0) {
          damageMult = crit.mult
        }
      }
      const bounces = this.hasCard('SC_RICOCHET') ? 1 : 0
      this.spawnProjectile(t.id, damageMult, 'BOLT', undefined, bounces)

      // Skill Card: UZI Spray - extra lighter shots.
      if (this.hasCard('SC_UZI_SPRAY')) {
        this.spawnProjectile(t.id, damageMult * 0.42, 'UZI', 1120, 0)
      }
    }

    // Skill Card: Drone Gunner - extra shot from an orbiting emitter.
    if (this.hasCard('SC_DRONE_GUNNER') && targets.length > 0) {
      const a = this.waveTimeSec * 2.1 + this.towerShotCounter * 0.23
      const ox = Math.cos(a) * 44
      const oy = Math.sin(a) * 44
      const origin = { x: this.towerPos.x + ox, y: this.towerPos.y + oy }
      const mainTarget = targets[0]
      const bounces = this.hasCard('SC_RICOCHET') ? 1 : 0
      this.spawnProjectile(mainTarget.id, 0.55, 'DRONE', 980, bounces, origin)
    }

    this.towerCooldown = cd
  }

  private spawnProjectile(
    targetEnemyId: number,
    damageMult: number,
    kind: ProjectileKind,
    speedOverride?: number,
    bouncesLeft: number = 0,
    origin?: { x: number; y: number },
  ) {
    const speed = Math.max(1, speedOverride ?? 920)
    this.projectiles.push({
      id: this.nextProjectileId++,
      x: origin ? origin.x : this.towerPos.x,
      y: origin ? origin.y : this.towerPos.y,
      speed,
      targetEnemyId,
      damageMult: Math.max(0.1, damageMult),
      alive: true,
      kind,
      bouncesLeft: Math.max(0, Math.floor(bouncesLeft)),
    })

    if (this.projectiles.length > 600) {
      this.projectiles = this.projectiles.filter((p) => p.alive)
    }
  }

  private stepProjectiles(dtSec: number) {
    if (this.projectiles.length === 0) return
    const hitR = 8

    // Avoid O(projectiles * enemies) scans.
    const enemyMap = new Map<number, EnemyEntity>()
    for (const e of this.enemies) if (e.alive) enemyMap.set(e.id, e)

    const pub = this.getPublic()

    for (const p of this.projectiles) {
      if (!p.alive) continue

      const target = enemyMap.get(p.targetEnemyId)
      if (!target || !target.alive) {
        p.alive = false
        if (getSkillRank(this._state, 'AT_COMBO_MOMENTUM') > 0) this.comboStacks = 0
        continue
      }

      const dx = target.x - p.x
      const dy = target.y - p.y
      const dist = Math.hypot(dx, dy)

      if (dist <= hitR) {
        const dmg = this.computeDamage(pub, target, p)
        this.applyDamageToEnemy(target, dmg)
        p.alive = false

        // Skill Card: Ricochet - bounce to a nearby second target.
        if (p.bouncesLeft > 0) {
          const bounceTarget = this.pickNearestEnemyExcluding(target.id, target.x, target.y, enemyMap, 220)
          if (bounceTarget) {
            this.emitCardFx({ kind: 'RICOCHET', x0: target.x, y0: target.y, x1: bounceTarget.x, y1: bounceTarget.y })
            this.spawnProjectile(bounceTarget.id, p.damageMult * 0.7, p.kind, p.speed, p.bouncesLeft - 1, { x: target.x, y: target.y })
          }
        }

        // Combo Momentum: increment stacks on hits.
        const comboRank = getSkillRank(this._state, 'AT_COMBO_MOMENTUM')
        if (comboRank > 0) {
          const maxStacks = clamp(2 + comboRank, 0, 5)
          this.comboStacks = Math.min(maxStacks, this.comboStacks + 1)
        }
        continue
      }

      const inv = dist <= 1e-6 ? 0 : 1 / dist
      const vx = dx * inv * p.speed
      const vy = dy * inv * p.speed
      p.x += vx * dtSec
      p.y += vy * dtSec
    }

    if (this.projectiles.length > 900) this.projectiles = this.projectiles.filter((p) => p.alive)
  }

  private stepSkillCards() {
    const cards = getEquippedSkillCards(this._state)
    if (cards.length === 0) return

    const pub = this.getPublic()
    const lead = this.pickTargets(pub, 1)[0]

    // Lightning Arc: periodic zap + chain.
    if (this.hasCard('SC_LIGHTNING_ARC') && lead && this.lightningCooldown <= 0) {
      this.lightningCooldown = 1.35
      const zapDmg = this.computeDamage(pub, lead, {
        id: -1,
        x: pub.tower.pos.x,
        y: pub.tower.pos.y,
        speed: 0,
        targetEnemyId: lead.id,
        damageMult: 0.55,
        alive: false,
        kind: 'BOLT',
        bouncesLeft: 0,
      })
      this.applyDamageToEnemy(lead, zapDmg)
      this.emitCardFx({ kind: 'LIGHTNING_ARC', x0: pub.tower.pos.x, y0: pub.tower.pos.y, x1: lead.x, y1: lead.y })

      const enemyMap = new Map<number, EnemyEntity>()
      for (const e of this.enemies) if (e.alive) enemyMap.set(e.id, e)
      const chained = this.pickNearestEnemyExcluding(lead.id, lead.x, lead.y, enemyMap, 210)
      if (chained) {
        this.applyDamageToEnemy(chained, Math.max(1, zapDmg * 0.42))
        this.emitCardFx({ kind: 'LIGHTNING_ARC', x0: lead.x, y0: lead.y, x1: chained.x, y1: chained.y })
      }
    }

    // Laser Beam: frequent low-mult ticks to the lead target.
    if (this.hasCard('SC_LASER_BEAM') && lead && this.laserTickCooldown <= 0) {
      this.laserTickCooldown = 0.18
      const beamDmg = this.computeDamage(pub, lead, {
        id: -2,
        x: pub.tower.pos.x,
        y: pub.tower.pos.y,
        speed: 0,
        targetEnemyId: lead.id,
        damageMult: 0.16,
        alive: false,
        kind: 'BOLT',
        bouncesLeft: 0,
      })
      this.applyDamageToEnemy(lead, beamDmg)
    }

    // Orbiting Sword: periodic close-range slashes.
    if (this.hasCard('SC_SPIN_SWORD') && this.swordTickCooldown <= 0) {
      this.swordTickCooldown = 0.32
      const r = 88
      const r2 = r * r
      for (const e of this.enemies) {
        if (!e.alive) continue
        const dx = e.x - pub.tower.pos.x
        const dy = e.y - pub.tower.pos.y
        if (dx * dx + dy * dy > r2) continue
        const dmg = Math.max(1, pub.tower.damagePerShot * 0.18)
        this.applyDamageToEnemy(e, dmg)
      }
    }

    // Wall Field: periodic ring pulse (damage + micro-slow near the ring).
    if (this.hasCard('SC_WALL_FIELD') && this.wallPulseCooldown <= 0) {
      this.wallPulseCooldown = 3.0
      const ringR = clamp(pub.tower.range * 0.65, 40, pub.tower.range)
      this.emitCardFx({ kind: 'WALL_PULSE', x: pub.tower.pos.x, y: pub.tower.pos.y, r: ringR })
      for (const e of this.enemies) {
        if (!e.alive) continue
        const dx = e.x - pub.tower.pos.x
        const dy = e.y - pub.tower.pos.y
        const d = Math.hypot(dx, dy)
        if (Math.abs(d - ringR) > 16) continue
        this.applySlow(e, 0.35, 0.75)
        this.applyDamageToEnemy(e, Math.max(1, pub.tower.damagePerShot * 0.12))
      }
    }

    // Freeze Pulse: big slow ring.
    if (this.hasCard('SC_FREEZE_PULSE') && this.freezePulseCooldown <= 0) {
      this.freezePulseCooldown = 4.4
      const r = clamp(pub.tower.range * 0.85, 120, pub.tower.range)
      this.emitCardFx({ kind: 'FREEZE_PULSE', x: pub.tower.pos.x, y: pub.tower.pos.y, r })
      const r2 = r * r
      for (const e of this.enemies) {
        if (!e.alive) continue
        const dx = e.x - pub.tower.pos.x
        const dy = e.y - pub.tower.pos.y
        if (dx * dx + dy * dy > r2) continue
        this.applySlow(e, 0.45, 1.25)
      }
    }

    // Mine Grid: periodic AoE on the lead enemy.
    if (this.hasCard('SC_MINE_GRID') && lead && this.mineCooldown <= 0) {
      this.mineCooldown = 2.35
      const r = 92
      this.emitCardFx({ kind: 'MINE_BLAST', x: lead.x, y: lead.y, r })
      const r2 = r * r
      for (const e of this.enemies) {
        if (!e.alive) continue
        const dx = e.x - lead.x
        const dy = e.y - lead.y
        if (dx * dx + dy * dy > r2) continue
        this.applyDamageToEnemy(e, Math.max(1, pub.tower.damagePerShot * 0.22))
      }
    }
  }

  private hasCard(id: SkillCardId): boolean {
    // Kept as a small helper so card logic stays readable.
    const cards = (this._state as any).skillCardsEquipped
    if (!cards) return false
    return cards[1] === id || cards[2] === id || cards[3] === id
  }

  private emitCardFx(fx: CardFxEvent) {
    this.cardFx.push({ id: this.nextCardFxId++, ...(fx as any) } as CardFx)
  }

  private applySlow(e: EnemyEntity, mult: number, durSec: number) {
    const until = this.waveTimeSec + Math.max(0, durSec)
    e.slowUntilSec = Math.max(e.slowUntilSec ?? 0, until)
    const next = clamp(mult, 0.1, 1)
    e.slowMult = typeof e.slowMult === 'number' ? Math.min(e.slowMult, next) : next
  }

  private applyDamageToEnemy(e: EnemyEntity, dmg: number) {
    e.hp -= dmg
    if (e.hp <= 0 && e.alive) {
      e.alive = false
      this.killed++
      this._state.stats.totalKills++
    }
  }

  private pickNearestEnemyExcluding(
    excludeId: number,
    x: number,
    y: number,
    enemyMap: Map<number, EnemyEntity>,
    maxDist: number,
  ): EnemyEntity | undefined {
    let best: EnemyEntity | undefined = undefined
    let bestD2 = maxDist * maxDist
    for (const e of enemyMap.values()) {
      if (!e.alive) continue
      if (e.id === excludeId) continue
      const dx = e.x - x
      const dy = e.y - y
      const d2 = dx * dx + dy * dy
      if (d2 > bestD2) continue
      if (!best || d2 < bestD2 || (d2 === bestD2 && e.id < best.id)) {
        best = e
        bestD2 = d2
      }
    }
    return best
  }

  private pickTargets(pub: SimPublic, count: number): EnemyEntity[] {
    const n = Math.max(1, Math.floor(count))
    const inRange: { e: EnemyEntity; progress: number }[] = []

    for (const e of this.enemies) {
      if (!e.alive) continue
      const dx = e.x - pub.tower.pos.x
      const dy = e.y - pub.tower.pos.y
      const dist = Math.hypot(dx, dy)
      if (dist > pub.tower.range) continue

      const progress = 1 - clamp(dist / Math.max(1, this.arena.maxSpawnDist), 0, 1)
      inRange.push({ e, progress })
    }

    inRange.sort((a, b) => {
      if (b.progress !== a.progress) return b.progress - a.progress
      return a.e.id - b.e.id
    })

    return inRange.slice(0, n).map((r) => r.e)
  }

  private computeDamage(pub: SimPublic, e: EnemyEntity, p: ProjectileEntity): number {
    const armorPierce = clamp(pub.tower.armorPierce, 0, 0.9)

    // Deterministic reduction: armor reduces flat portion.
    const armorEffective = e.armor * (1 - armorPierce)
    let raw = pub.tower.damagePerShot * Math.max(0.1, p.damageMult)

    // Execution Window: +12% vs enemies below 20% HP.
    if (getSkillRank(this._state, 'AT_EXECUTION_WINDOW') > 0 && e.maxHP > 0 && e.hp / e.maxHP <= 0.2) {
      raw *= 1.12
    }

    // Marked Targets: opening-volley bonus vs high-HP enemies.
    if (getSkillRank(this._state, 'AT_MARKED_TARGETS') > 0 && e.maxHP > 0 && e.hp / e.maxHP >= 0.8) {
      raw *= 1.06
    }

    // Combo Momentum: damage scales with current stacks; misses reset elsewhere.
    if (getSkillRank(this._state, 'AT_COMBO_MOMENTUM') > 0) {
      raw *= 1 + 0.01 * clamp(this.comboStacks, 0, 5)
    }

    return Math.max(1, raw - armorEffective * 10)
  }

  private applyTowerRepair(dtSec: number) {
    const pct = towerRepairPctPerSec(this._state, this.cfg, this.getSkillsCached())
    if (pct <= 0) return

    const maxHP = calcBaseHPMax(this._state, this.cfg)

    // Repair heals a fraction of *missing* HP per second. This avoids instantly refilling
    // to full when only slightly damaged, while still allowing meaningful recovery.
    const missing = Math.max(0, maxHP - this._state.baseHP)
    this._state.baseHP = clamp(this._state.baseHP + missing * pct * dtSec, 0, maxHP)
  }

  private maybeTriggerEmergencyKit() {
    if (!this._state.skills) return
    if (this.emergencyKitUsedThisWave) return
    if (getSkillRank(this._state, 'UT_EMERGENCY_KIT') <= 0) return
    const cd = Math.max(0, Math.floor(this._state.skills.cooldowns.emergencyKitWaves ?? 0))
    if (cd > 0) return

    const T = this.cfg.sim.waveDurationSec
    if (!(this.waveTimeSec >= T * 0.5)) return

    const maxHP = calcBaseHPMax(this._state, this.cfg)
    if (maxHP <= 0) return
    if (this._state.baseHP >= maxHP) return

    this._state.baseHP = clamp(this._state.baseHP + 0.06 * maxHP, 0, maxHP)
    const cdMult = this.getSkillsCached().cooldownMult
    this._state.skills.cooldowns.emergencyKitWaves = Math.max(1, Math.ceil(2 * cdMult))
    this.emergencyKitUsedThisWave = true
    this.lastProc = 'EMERGENCY_KIT'
    this.lastProcUntilSec = this.waveTimeSec + 1.5
  }

  private maybeTriggerInvulnerability() {
    const mods = this.getModsCached()
    const duration = mods.invulnDurationSec
    const cooldown = mods.invulnCooldownSec

    if (duration <= 0 || cooldown <= 0) return
    if (this.invulnRemainingSec > 0) return
    if (this.invulnCooldownRemainingSec > 0) return
    if (this.enemies.length === 0) return

    this.invulnRemainingSec = duration
    this.invulnCooldownRemainingSec = cooldown
  }

  private finishWave() {
    // Wave uses the snapshot for rewards/penalty.
    const report = calcWaveReport({
      state: this._state,
      snapshot: this.snapshot,
      killed: this.killed,
      escaped: this.escaped,
      cfg: this.cfg,
    })

    // Escape damage is applied instantly on each escape; keep the report consistent.
    report.baseDamageFromEscapes = this.escapeDamageAppliedThisWave

    // Skills: wave-end XP progression.
    if (this._state.skills) {
      const levelBefore = Math.max(0, Math.floor(this._state.skills.level ?? 0))
      const { mult, gain } = calcWaveXpGain(this._state.wave, this.cfg)
      const skills = aggregateSkillPassives(this._state)
      const finalGain = Math.max(0, Math.floor(gain * Math.max(0, skills.xpGainMult)))
      report.xpGain = finalGain
      report.xpMultiplier = mult
      report.levelBefore = levelBefore

      this._state.skills.xp = Math.max(0, Math.floor(this._state.skills.xp ?? 0) + finalGain)
      let lvl = levelBefore
      let safety = 0
      while (this._state.skills.xp >= xpToNext(lvl) && safety++ < 500) {
        this._state.skills.xp -= xpToNext(lvl)
        lvl++
        this._state.skills.skillPoints = Math.max(0, Math.floor(this._state.skills.skillPoints ?? 0) + 1)
      }
      this._state.skills.level = lvl
      report.levelAfter = lvl
    }

    this._state.gold += report.rewardGold

    // Paladyum (points) is awarded deterministically at wave end.
    this._state.points += report.rewardPoints
    this._state.stats.paladyumDroppedThisRun = Math.max(0, Math.floor((this._state.stats.paladyumDroppedThisRun ?? 0) + report.rewardPoints))

    // Recovery Pulse: heal at wave end based on max HP.
    if (this._state.skills) {
      const r = getSkillRank(this._state, 'DF_RECOVERY_PULSE')
      if (r > 0) {
        const maxHP = calcBaseHPMax(this._state, this.cfg)
        this._state.baseHP = clamp(this._state.baseHP + maxHP * (0.02 * r), 0, maxHP)
        this.lastProc = 'RECOVERY_PULSE'
        this.lastProcUntilSec = this.waveTimeSec + 2
      }
    }

    if (this._state.baseHP <= 0) {
      const sum: RunSummary = {
        endedAtWave: this._state.wave,
        totalGoldThisRun: this._state.gold,
        totalTimeSec: this._state.stats.totalTimeSec,
      }

      this.cb.onGameOver(sum)
      this.paused = true
      return
    }

    this.cb.onWaveComplete(report)

    // Pause on wave complete; advance only when UI explicitly continues.
    this.paused = true
    this.awaitingNextWave = true
  }

  private createArena(viewport: { width: number; height: number }): {
    center: Vec2
    bounds: { left: number; top: number; right: number; bottom: number }
    maxSpawnDist: number
    baseHalfSize: number
  } {
    const w = viewport.width
    const h = viewport.height
    const min = Math.min(w, h)

    const margin = Math.max(12, min * 0.06)
    const bounds = {
      left: margin,
      top: margin,
      right: Math.max(margin + 1, w - margin),
      bottom: Math.max(margin + 1, h - margin),
    }

    const center = { x: w * 0.5, y: h * 0.5 }
    const corners = [
      { x: bounds.left, y: bounds.top },
      { x: bounds.right, y: bounds.top },
      { x: bounds.right, y: bounds.bottom },
      { x: bounds.left, y: bounds.bottom },
    ]
    let maxSpawnDist = 0
    for (const c of corners) {
      maxSpawnDist = Math.max(maxSpawnDist, Math.hypot(c.x - center.x, c.y - center.y))
    }

    return {
      center,
      bounds,
      maxSpawnDist,
      // Base zone radius.
      baseHalfSize: Math.max(18, min * 0.032) * 1.05,
    }
  }

  private calcSpawnPoint(wave: number, index1: number): Vec2 {
    // Deterministic spawn along the rectangle perimeter.
    const w = Math.max(1, Math.floor(wave))
    const i = Math.max(1, Math.floor(index1))
    const MOD = 997

    const rawA = 131 * w + 197 * i + 17
    const rawB = 389 * w + 73 * i + 29
    const a = (((rawA % MOD) + MOD) % MOD) / MOD
    const b = (((rawB % MOD) + MOD) % MOD) / MOD

    const edge = Math.floor(b * 4) % 4
    const t = a

    const { left, top, right, bottom } = this.arena.bounds
    const lerp = (p0: number, p1: number, u: number) => p0 + (p1 - p0) * u

    if (edge === 0) return { x: lerp(left, right, t), y: top }
    if (edge === 1) return { x: right, y: lerp(top, bottom, t) }
    if (edge === 2) return { x: lerp(left, right, t), y: bottom }
    return { x: left, y: lerp(top, bottom, t) }
  }
}
