import type { GameConfig, GameState, RunSummary, WaveReport, WaveSnapshot } from '../types'
import {
  aggregateModules,
  baseDmg,
  calcPenaltyFactor,
  calcEnemyStats,
  calcSpawnTimeSec,
  calcWaveReport,
  calcWaveSnapshot,
  clamp,
  effectiveCritParams,
  effectiveEnemySpeedMult,
  fireRate,
  towerMultiShotCount,
  towerArmorPierceBonus,
  towerEscapeDamageMult,
  towerRepairPctPerSec,
  towerRange,
} from './deterministic'
import type { Vec2 } from './path'

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
}

export type ProjectileEntity = {
  id: number
  x: number
  y: number
  speed: number
  targetEnemyId: number
  damageMult: number
  alive: boolean
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

  private towerPos: Vec2 = { x: 0, y: 0 }
  private towerCooldown = 0
  private towerShotCounter = 0

  private invulnRemainingSec = 0
  private invulnCooldownRemainingSec = 0

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
    this.snapshot = calcWaveSnapshot(this._state, this.cfg)
    this.buildSpawnPlan()
  }

  getPublic(): SimPublic {
    const mods = aggregateModules(this._state, this.cfg)

    const damagePerShot =
      (baseDmg(this._state.towerUpgrades.damageLevel, this.cfg) * mods.dmgMult + mods.dmgFlat) *
      (1 + 0) *
      (1 + 0) *
      (1 + 0) *
      (1 + 0)

    const fr = fireRate(this._state.towerUpgrades.fireRateLevel, this.cfg) * (1 + mods.fireRateBonus)
    const range = towerRange(this._state.towerUpgrades.rangeLevel, this.cfg) + mods.rangeBonus
    const armorPierce = clamp(mods.armorPierce + towerArmorPierceBonus(this._state, this.cfg), 0, 0.9)

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
    // Do NOT recompute snapshot, wave time, spawn plan, or runtime counters.
    this.cb.onStateChanged(this._state)
  }

  setSnapshot(state: GameState) {
    this._state = { ...state }
    this.waveMods = aggregateModules(this._state, this.cfg)
    this.snapshot = calcWaveSnapshot(this._state, this.cfg)
    this.resetWaveRuntime()
    this.buildSpawnPlan()
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
    this.snapshot = calcWaveSnapshot(this._state, this.cfg)
    this.resetWaveRuntime()
    this.buildSpawnPlan()

    this.paused = false
    this.cb.onStateChanged(this._state)
  }

  setTimeScale(scale: 1 | 2 | 3) {
    this.timeScale = scale
  }

  tick(dtSec: number) {
    if (this.paused) return

    const scaled = dtSec * this.timeScale

    // Utility abilities (deterministic; time-based).
    this.invulnRemainingSec = Math.max(0, this.invulnRemainingSec - scaled)
    this.invulnCooldownRemainingSec = Math.max(0, this.invulnCooldownRemainingSec - scaled)

    this.waveTimeSec += scaled
    this._state.stats.totalTimeSec += scaled

    // Defense: deterministic self-repair (regen) based on max HP.
    // Applied continuously while unpaused.
    this.applyTowerRepair(scaled)

    this.maybeTriggerInvulnerability()

    this.spawnEnemiesUpToTime(this.waveTimeSec)
    this.stepEnemies(scaled)
    if (this.paused) {
      this.cb.onStateChanged(this._state)
      return
    }
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
  }

  private applyEscapeDamageNow(count: number) {
    if (!this.cfg.progression.enableEscapeDamage) return
    if (count <= 0) return
    if (this.invulnRemainingSec > 0) return

    const N = Math.max(1, this.snapshot.spawnCount)
    const killRatioNow = clamp(this.killed / N, 0, 1)
    const { deficit } = calcPenaltyFactor(killRatioNow, this.snapshot.threshold, this.cfg)

    const perEscape = this.cfg.progression.escapeDamage * (1 + this.cfg.progression.deficitBoost * deficit)
    const afterFortify = perEscape * towerEscapeDamageMult(this._state, this.cfg)
    const dmg = Math.max(0, afterFortify * count)

    this.escapeDamageAppliedThisWave += dmg
    this._state.baseHP = Math.max(0, this._state.baseHP - dmg)

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
    const speedMult = effectiveEnemySpeedMult(this._state, this.cfg)
    for (const e of this.enemies) {
      if (!e.alive) continue

      e.x += e.vx * dtSec * speedMult
      e.y += e.vy * dtSec * speedMult

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

    const mods = aggregateModules(this._state, this.cfg)
    const baseShots = towerMultiShotCount(this._state, this.cfg)
    const totalShots = Math.max(1, Math.floor(Math.max(baseShots, mods.shotCount)))
    const targets = this.pickTargets(pub, totalShots)
    if (targets.length === 0) return

    const crit = effectiveCritParams(this._state, this.cfg, mods)

    // Spawn visible projectiles; damage is applied on impact.
    for (const t of targets) {
      let damageMult = 1
      if (Number.isFinite(crit.everyN) && crit.everyN !== Number.POSITIVE_INFINITY && crit.mult > 1.000001) {
        this.towerShotCounter++
        if (this.towerShotCounter % Math.max(1, Math.floor(crit.everyN)) === 0) {
          damageMult = crit.mult
        }
      }
      this.spawnProjectile(t.id, damageMult)
    }

    this.towerCooldown = cd
  }

  private spawnProjectile(targetEnemyId: number, damageMult: number) {
    const speed = 920
    this.projectiles.push({
      id: this.nextProjectileId++,
      x: this.towerPos.x,
      y: this.towerPos.y,
      speed,
      targetEnemyId,
      damageMult: Math.max(0.1, damageMult),
      alive: true,
    })

    if (this.projectiles.length > 600) {
      this.projectiles = this.projectiles.filter((p) => p.alive)
    }
  }

  private stepProjectiles(dtSec: number) {
    if (this.projectiles.length === 0) return
    const hitR = 8

    for (const p of this.projectiles) {
      if (!p.alive) continue

      const target = this.enemies.find((e) => e.id === p.targetEnemyId)
      if (!target || !target.alive) {
        p.alive = false
        continue
      }

      const dx = target.x - p.x
      const dy = target.y - p.y
      const dist = Math.hypot(dx, dy)

      if (dist <= hitR) {
        const pub = this.getPublic()
        const dmg = this.computeDamage(pub, target, p)
        target.hp -= dmg
        if (target.hp <= 0 && target.alive) {
          target.alive = false

          this.killed++
          this._state.stats.totalKills++
        }
        p.alive = false
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
    const raw = pub.tower.damagePerShot * Math.max(0.1, p.damageMult)
    return Math.max(1, raw - armorEffective * 10)
  }

  private applyTowerRepair(dtSec: number) {
    const pct = towerRepairPctPerSec(this._state, this.cfg)
    if (pct <= 0) return

    const mods = aggregateModules(this._state, this.cfg)
    const baseHPLevel = Math.max(1, Math.floor(this._state.towerUpgrades.baseHPLevel))
    const base = this.cfg.tower.baseHP0 * Math.pow(1 + this.cfg.tower.baseHPGrowth, baseHPLevel - 1)
    const maxHP = Math.max(1, (base + mods.baseHPBonus) * mods.baseHPMult)

    // Repair heals a fraction of *missing* HP per second. This avoids instantly refilling
    // to full when only slightly damaged, while still allowing meaningful recovery.
    const missing = Math.max(0, maxHP - this._state.baseHP)
    this._state.baseHP = clamp(this._state.baseHP + missing * pct * dtSec, 0, maxHP)
  }

  private maybeTriggerInvulnerability() {
    const mods = aggregateModules(this._state, this.cfg)
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

    this._state.gold += report.rewardGold

    // Paladyum (points) is awarded deterministically at wave end.
    this._state.points += report.rewardPoints
    this._state.stats.paladyumDroppedThisRun = Math.max(0, Math.floor((this._state.stats.paladyumDroppedThisRun ?? 0) + report.rewardPoints))

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
