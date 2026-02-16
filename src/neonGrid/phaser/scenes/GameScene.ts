import Phaser from 'phaser'
import type { GameConfig, GameState } from '../../types'
import { SimEngine, type SimCallbacks, type SimPublic } from '../../sim/SimEngine'
import { calcBaseHPMax } from '../../sim/actions'

export class GameScene extends Phaser.Scene {
  private cfg!: GameConfig
  private engine!: SimEngine
  private onSimPublic!: (pub: SimPublic) => void

  private bgm?: Phaser.Sound.BaseSound

  private accumulator = 0
  private fixedDt = 1 / 60

  private gfx!: Phaser.GameObjects.Graphics
  private fx!: Phaser.GameObjects.Graphics

  private vTimeSec = 0

  private hiddenAtUTC: number | null = null

  private prevEnemyHP = new Map<number, number>()
  private prevEnemyAlive = new Map<number, boolean>()
  private enemyHitFx = new Map<number, { untilSec: number; crit: boolean }>()
  private prevEnemyPos = new Map<number, { x: number; y: number }>()

  private enemyDeathFx: Array<{ x: number; y: number; t0: number; kind: 'kill' | 'escape' }> = []

  private prevProjectilePos = new Map<number, { x: number; y: number }>()
  private prevProjectileAlive = new Map<number, boolean>()

  private projectileImpactFx: Array<{ x: number; y: number; t0: number; crit: boolean; a: number; id: number; targetId: number }> = []
  private muzzleFxUntilSec = 0
  private muzzleCritUntilSec = 0
  private prevBaseHP = Number.NaN

  private towerPulseUntilSec = 0
  private baseImpactUntilSec = 0
  private lastImpactShakeAtSec = -999

  constructor() {
    super('Game')
  }

  create() {
    const bridge = this.game.registry.get('neonGrid.init') as {
      cfg: GameConfig
      initialState: GameState
      callbacks: SimCallbacks
      onEngineReady: (e: SimEngine) => void
      onSimPublic: (pub: SimPublic) => void
    }

    this.cfg = bridge.cfg
    this.onSimPublic = bridge.onSimPublic

    this.fixedDt = 1 / this.cfg.sim.tickHz

    this.gfx = this.add.graphics()
    this.fx = this.add.graphics()
    this.fx.setBlendMode(Phaser.BlendModes.ADD)

    this.engine = new SimEngine({
      initialState: bridge.initialState,
      config: this.cfg,
      callbacks: bridge.callbacks,
      viewport: { width: this.scale.width, height: this.scale.height },
    })

    bridge.onEngineReady(this.engine)

    this.initBgm()

    // Phaser (and browsers) can throttle/pause the main loop on tab switches.
    // To avoid the game feeling "stuck", track time spent away and feed it into
    // the sim accumulator when focus returns.
    this.installFocusRecovery()

    const onResize = (gameSize: Phaser.Structs.Size) => {
      this.engine.setViewport({ width: gameSize.width, height: gameSize.height })
    }
    this.scale.on('resize', onResize)
    const removeResize = () => this.scale.off('resize', onResize)
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => removeResize())
    this.events.once(Phaser.Scenes.Events.DESTROY, () => removeResize())
  }

  private installFocusRecovery() {
    const onHidden = () => {
      this.hiddenAtUTC = Date.now()
    }

    const onVisible = () => {
      if (this.hiddenAtUTC === null) return
      const elapsedSec = Math.max(0, (Date.now() - this.hiddenAtUTC) / 1000)
      this.hiddenAtUTC = null

      // Only catch up when gameplay is actually running.
      // If the user paused (menu / wave complete), keep it paused.
      if (!this.engine?.isPaused()) {
        this.accumulator = Math.min(30, this.accumulator + elapsedSec)
      }
    }

    const onVisibility = () => {
      if (document.hidden) onHidden()
      else onVisible()
    }

    const onBlur = () => {
      // Some platforms may fire blur without a visibility change (e.g. app switch).
      if (this.hiddenAtUTC === null) onHidden()
    }

    const onFocus = () => {
      onVisible()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)

    const remove = () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => remove())
    this.events.once(Phaser.Scenes.Events.DESTROY, () => remove())
  }

  update(_time: number, deltaMs: number) {
    // When the tab is inactive, browsers may throttle RAF/timeouts.
    // Delta can become very large; don't drop that time (feels like the game "stops").
    // Instead, keep it in an accumulator and process a bounded amount per frame,
    // letting the sim catch up over a few frames after returning.
    const rawDeltaSec = deltaMs / 1000
    const deltaSec = Number.isFinite(rawDeltaSec) ? Math.max(0, rawDeltaSec) : 0

    // Visual time is kept stable to avoid huge pulse jumps.
    this.vTimeSec += Math.min(0.25, deltaSec)
    this.accumulator += deltaSec

    // Prevent a single long-delayed frame from doing unbounded work.
    // (This also avoids locking up the UI after a long tab switch.)
    const maxSimSecPerFrame = 0.75
    const maxSteps = Math.max(1, Math.ceil(maxSimSecPerFrame / this.fixedDt))
    let steps = 0
    while (this.accumulator >= this.fixedDt && steps < maxSteps) {
      this.engine.tick(this.fixedDt)
      this.accumulator -= this.fixedDt
      steps++
    }

    // Keep the backlog bounded; if the user was away for hours, we don't want
    // to spend minutes fast-forwarding. (This is "tab switch" smoothing, not offline sim.)
    this.accumulator = Math.min(this.accumulator, 30)

    const pub = this.engine.getPublic()
    this.onSimPublic(pub)
    this.render(pub)

    // Keep volume in sync with state (UI slider).
    if (this.sound) {
      const muted = !!(pub.state.settings as any).audioMuted
      this.sound.mute = muted
      this.sound.volume = clamp01(pub.state.settings.audioMaster)
    }
  }

  private initBgm() {
    const key = 'neonGrid.bgm'

    const fromRegistry = this.game.registry.get(key) as Phaser.Sound.BaseSound | undefined
    if (fromRegistry) {
      this.bgm = fromRegistry
    } else {
      // Ensure audio is attempted again after a user gesture (browser autoplay policies).
      document.addEventListener(
        'pointerdown',
        () => {
          this.tryStartBgm(key)
        },
        { once: true, capture: true },
      )
      this.tryStartBgm(key)
    }

    // Apply initial volume.
    try {
      const s = this.engine?.getSnapshot()
      if (s) {
        const muted = !!(s.settings as any).audioMuted
        this.sound.mute = muted
        this.sound.volume = clamp01(s.settings.audioMaster)
      }
    } catch {
      // ignore
    }
  }

  private tryStartBgm(registryKey: string) {
    if (this.bgm) return
    if (!this.cache.audio.exists('bgm')) return

    const music = this.sound.add('bgm', { loop: true })
    const ok = music.play()
    if (!ok) return

    this.bgm = music
    this.game.registry.set(registryKey, music)
  }

  private render(pub: SimPublic) {
    const w = this.scale.width
    const h = this.scale.height

    const reduceFx = !!pub.state.settings.reduceEffects

    this.gfx.clear()
    this.fx.clear()

    // Maintain compact effect buffers to keep perf stable.
    if (this.enemyDeathFx.length > 64) this.enemyDeathFx = this.enemyDeathFx.slice(-64)
    if (this.projectileImpactFx.length > 96) this.projectileImpactFx = this.projectileImpactFx.slice(-96)

    // Background grid
    const pal = this.cfg.ui.palette
    const cyan = hexTo0x(pal.neonCyan)
    const magenta = hexTo0x(pal.neonMagenta)
    const lime = hexTo0x(pal.neonLime)
    const text = hexTo0x(pal.text)
    const danger = hexTo0x(pal.danger)
    const bg = hexTo0x(pal.bg)

    const gridAlpha = reduceFx ? 0.055 : 0.05 + 0.02 * (0.5 + 0.5 * Math.sin(this.vTimeSec * 0.65))
    this.gfx.lineStyle(1, cyan, gridAlpha)
    const grid = 48
    for (let x = 0; x <= w; x += grid) this.gfx.lineBetween(x, 0, x, h)
    for (let y = 0; y <= h; y += grid) this.gfx.lineBetween(0, y, w, y)

    if (!reduceFx) {
      // Subtle secondary glow grid.
      const gridAlpha2 = 0.015 + 0.02 * (0.5 + 0.5 * Math.sin(this.vTimeSec * 0.9 + 1.3))
      this.gfx.lineStyle(2, magenta, gridAlpha2)
      for (let x = 0; x <= w; x += grid * 2) this.gfx.lineBetween(x, 0, x, h)
      for (let y = 0; y <= h; y += grid * 2) this.gfx.lineBetween(0, y, w, y)
    }

    // Arena bounds (full width/height playfield)
    const b = pub.arena.bounds
    this.gfx.lineStyle(2, cyan, 0.14)
    this.gfx.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top)

    // Base zone (escape trigger)
    const half = pub.arena.baseHalfSize
    const basePulse = reduceFx ? 0 : 0.7 + 0.3 * Math.sin(this.vTimeSec * 1.1)
    this.gfx.lineStyle(2, magenta, 0.16 + 0.06 * basePulse)
    this.gfx.strokeCircle(pub.arena.center.x, pub.arena.center.y, half)
    if (!reduceFx) {
      this.fx.lineStyle(2, magenta, 0.07)
      this.fx.strokeCircle(pub.arena.center.x, pub.arena.center.y, half + 4 + 4 * (0.5 + 0.5 * Math.sin(this.vTimeSec * 1.7)))
    }

    // Tower
    const towerBob = reduceFx ? 0 : 0.8 * Math.sin(this.vTimeSec * 2.2)
    const towerX = pub.tower.pos.x
    const towerY = pub.tower.pos.y + towerBob
    this.drawTower({ x: towerX, y: towerY, t: this.vTimeSec, reduceFx, cyan, magenta, lime, text })

    // Tower pulse/recoil feedback on shots (purely visual).
    if (!reduceFx && this.vTimeSec < this.towerPulseUntilSec) {
      const k = clamp01((this.towerPulseUntilSec - this.vTimeSec) / 0.14)
      const r = 16 + (1 - k) * 26
      this.fx.lineStyle(2, lime, 0.10 * k)
      this.fx.strokeCircle(towerX, towerY, r)
      this.fx.lineStyle(2, cyan, 0.06 * k)
      this.fx.strokeCircle(towerX, towerY, r * 0.72)
    }

    // Base HP (shown as a bar above the tower/base)
    const maxHP = Math.max(1, calcBaseHPMax(pub.state, this.cfg))
    const hpPct = clamp01(pub.state.baseHP / maxHP)
    const barW = 58
    const barH = 7
    const x0 = pub.tower.pos.x - barW / 2
    const y0 = pub.tower.pos.y - 18
    this.gfx.fillStyle(bg, 0.65)
    this.gfx.fillRoundedRect(x0, y0, barW, barH, 3)
    this.gfx.lineStyle(1, cyan, 0.22)
    this.gfx.strokeRoundedRect(x0, y0, barW, barH, 3)
    this.gfx.fillStyle(lime, 0.85)
    this.gfx.fillRoundedRect(x0 + 1, y0 + 1, Math.max(0, (barW - 2) * hpPct), barH - 2, 2)

    // Base damage feedback (very subtle).
    if (!Number.isFinite(this.prevBaseHP)) this.prevBaseHP = pub.state.baseHP
    if (pub.state.baseHP < this.prevBaseHP - 1e-9) {
      if (!reduceFx) {
        this.enemyDeathFx.push({ x: pub.tower.pos.x, y: pub.tower.pos.y, t0: this.vTimeSec, kind: 'escape' })
        this.muzzleFxUntilSec = Math.max(this.muzzleFxUntilSec, this.vTimeSec + 0.08)
        this.baseImpactUntilSec = Math.max(this.baseImpactUntilSec, this.vTimeSec + 0.45)
        this.cameras.main.shake(90, 0.002)
      }
    }
    this.prevBaseHP = pub.state.baseHP

    // Base impact / escape shockwave + subtle screen flash.
    if (!reduceFx && this.vTimeSec < this.baseImpactUntilSec) {
      const k = clamp01((this.baseImpactUntilSec - this.vTimeSec) / 0.45)
      const b = pub.arena.baseHalfSize
      const r1 = b + (1 - k) * 120
      const r2 = b * 0.9 + (1 - k) * 70
      this.fx.lineStyle(3, danger, 0.16 * k)
      this.fx.strokeCircle(pub.arena.center.x, pub.arena.center.y, r1)
      this.fx.lineStyle(2, magenta, 0.08 * k)
      this.fx.strokeCircle(pub.arena.center.x, pub.arena.center.y, r2)
      this.fx.fillStyle(danger, 0.020 * k)
      this.fx.fillCircle(pub.arena.center.x, pub.arena.center.y, r2)

      // Full-screen flash to sell the "escape hit".
      this.fx.fillStyle(danger, 0.018 * k)
      this.fx.fillRect(0, 0, w, h)
    }

    // Range ring (subtle)
    const rangeAlpha = reduceFx ? 0.16 : 0.12 + 0.06 * (0.5 + 0.5 * Math.sin(this.vTimeSec * 1.15))
    this.gfx.lineStyle(1, magenta, rangeAlpha)
    this.gfx.strokeCircle(towerX, towerY, pub.tower.range)

    // Projectiles
    if (pub.projectiles.length > 0) {
      this.gfx.fillStyle(cyan, 0.9)
      let shotThisFrame = false
      let critShotThisFrame = false
      for (const p of pub.projectiles) {
        const wasAlive = this.prevProjectileAlive.get(p.id) ?? false
        this.prevProjectileAlive.set(p.id, p.alive)

        const prev = this.prevProjectilePos.get(p.id)
        this.prevProjectilePos.set(p.id, { x: p.x, y: p.y })

        // Detect impact (projectile died this frame). We treat all deaths as hits;
        // missing is rare (target gone) and still looks fine as a tiny fizz.
        if (!reduceFx && wasAlive && !p.alive) {
          const a = prev ? Math.atan2(p.y - prev.y, p.x - prev.x) : 0
          const crit = p.damageMult > 1.000001
          this.projectileImpactFx.push({ x: p.x, y: p.y, t0: this.vTimeSec, crit, a, id: p.id, targetId: p.targetEnemyId })

          // Also drive enemy hit flash so impacts + enemy feedback match.
          // If the enemy died this frame, the death burst will dominate anyway.
          this.setEnemyHitFx(p.targetEnemyId, crit ? 0.22 : 0.16, crit)

          // Small camera shake on crit impacts (throttled).
          if (crit && this.vTimeSec - this.lastImpactShakeAtSec > 0.12) {
            this.lastImpactShakeAtSec = this.vTimeSec
            this.cameras.main.shake(55, 0.0014)
          }
        }

        if (!p.alive) continue

        if (!wasAlive) {
          shotThisFrame = true
          if (p.damageMult > 1.000001) critShotThisFrame = true
        }

        const isCrit = p.damageMult > 1.000001
        const c = isCrit ? lime : cyan

        if (!reduceFx && prev && wasAlive) {
          // Directional additive trail (thicker for crits).
          const dx = p.x - prev.x
          const dy = p.y - prev.y
          const dist = Math.hypot(dx, dy)
          const a = clamp01((dist / 18) * (isCrit ? 1.15 : 1))
          this.fx.lineStyle(isCrit ? 4 : 3, c, (isCrit ? 0.13 : 0.11) * a)
          this.fx.lineBetween(prev.x, prev.y, p.x, p.y)

          // Soft glow head.
          this.fx.fillStyle(c, (isCrit ? 0.08 : 0.06) * a)
          this.fx.fillCircle(p.x, p.y, isCrit ? 7.5 : 6.0)
        }

        // Bolt-style projectile body: a short streak in travel direction.
        if (prev) {
          const dx = p.x - prev.x
          const dy = p.y - prev.y
          const dist = Math.hypot(dx, dy)
          const inv = dist <= 1e-6 ? 0 : 1 / dist
          const nx = dx * inv
          const ny = dy * inv
          const len = (isCrit ? 9.5 : 7.5) + Math.min(10, dist * 0.55)
          const bx0 = p.x - nx * len
          const by0 = p.y - ny * len
          const bx1 = p.x + nx * 2.2
          const by1 = p.y + ny * 2.2

          this.gfx.lineStyle(isCrit ? 3 : 2, c, 0.95)
          this.gfx.lineBetween(bx0, by0, bx1, by1)
          this.gfx.fillStyle(c, 0.9)
          this.gfx.fillCircle(p.x, p.y, isCrit ? 2.9 : 2.4)
        } else {
          // Fallback first frame.
          this.gfx.fillStyle(c, 0.9)
          this.gfx.fillCircle(p.x, p.y, isCrit ? 3.0 : 2.5)
        }
      }

      if (!reduceFx && shotThisFrame) {
        this.muzzleFxUntilSec = Math.max(this.muzzleFxUntilSec, this.vTimeSec + 0.09)
        if (critShotThisFrame) this.muzzleCritUntilSec = Math.max(this.muzzleCritUntilSec, this.vTimeSec + 0.12)
        this.towerPulseUntilSec = Math.max(this.towerPulseUntilSec, this.vTimeSec + (critShotThisFrame ? 0.18 : 0.14))
      }
    }

    // Cleanup old projectile positions.
    if (this.prevProjectilePos.size > 1600) {
      for (const [id, _] of this.prevProjectilePos) {
        const alive = this.prevProjectileAlive.get(id)
        if (!alive) {
          this.prevProjectilePos.delete(id)
          this.prevProjectileAlive.delete(id)
        }
      }
    }

    // Projectile impacts.
    if (!reduceFx && this.projectileImpactFx.length > 0) {
      const keep: typeof this.projectileImpactFx = []
      for (const fx of this.projectileImpactFx) {
        const age = this.vTimeSec - fx.t0
        const dur = fx.crit ? 0.28 : 0.22
        if (age < 0 || age > dur) continue
        keep.push(fx)

        const k = clamp01(1 - age / dur)
        const c = fx.crit ? lime : cyan
        const r = (fx.crit ? 6 : 5) + age * (fx.crit ? 90 : 70)

        this.fx.lineStyle(fx.crit ? 3 : 2, c, 0.16 * k)
        this.fx.strokeCircle(fx.x, fx.y, r)
        this.fx.lineStyle(2, magenta, 0.06 * k)
        this.fx.strokeCircle(fx.x, fx.y, r * 0.62)
        this.fx.fillStyle(c, 0.03 * k)
        this.fx.fillCircle(fx.x, fx.y, r * 0.35)

        // Mini sparks (deterministic): 3 rays for normal, 5 for crit.
        const rays = fx.crit ? 5 : 3
        const baseLen = fx.crit ? 18 : 13
        const spread = fx.crit ? 0.9 : 0.75
        const phase = (fx.id % 17) * 0.37
        for (let i = 0; i < rays; i++) {
          // Use a mix of travel direction and a deterministic offset.
          const off = (i - (rays - 1) / 2) * spread + 0.25 * Math.sin(phase + i * 1.7)
          const a = fx.a + off
          const len = baseLen * (0.55 + 0.45 * Math.sin(phase + i * 2.1 + 1.2))
          const x0 = fx.x + Math.cos(a) * (4 + (1 - k) * 3)
          const y0 = fx.y + Math.sin(a) * (4 + (1 - k) * 3)
          const x1 = x0 + Math.cos(a) * len * k
          const y1 = y0 + Math.sin(a) * len * k

          this.fx.lineStyle(fx.crit ? 3 : 2, c, (fx.crit ? 0.13 : 0.11) * k)
          this.fx.lineBetween(x0, y0, x1, y1)
          this.fx.lineStyle(2, magenta, 0.05 * k)
          this.fx.lineBetween(x0, y0, x1, y1)
        }
      }
      this.projectileImpactFx = keep
    }

    // Muzzle flash when new projectile(s) appear.
    if (!reduceFx && this.vTimeSec < this.muzzleFxUntilSec) {
      const k = clamp01((this.muzzleFxUntilSec - this.vTimeSec) / 0.09)
      const r = 10 + (1 - k) * 18
      const isCrit = this.vTimeSec < this.muzzleCritUntilSec
      const c = isCrit ? lime : cyan
      const w = isCrit ? 3 : 2
      this.fx.lineStyle(w, c, (isCrit ? 0.16 : 0.14) * k)
      this.fx.strokeCircle(towerX, towerY, r)

      if (isCrit) {
        const k2 = clamp01((this.muzzleCritUntilSec - this.vTimeSec) / 0.12)
        this.fx.lineStyle(2, magenta, 0.09 * k2)
        this.fx.strokeCircle(towerX, towerY, r + 10 + (1 - k2) * 8)
      }
    }

    // Enemies
    const drawEnemyTrails = !reduceFx && pub.enemies.length <= 260
    for (const e of pub.enemies) {
      const prevAlive = this.prevEnemyAlive.get(e.id) ?? false
      const prevHP = this.prevEnemyHP.get(e.id)

      const prevPos = this.prevEnemyPos.get(e.id)
      this.prevEnemyPos.set(e.id, { x: e.x, y: e.y })

      // Detect damage and transitions.
      if (e.alive) {
        if (typeof prevHP === 'number' && e.hp < prevHP - 1e-9) {
          // Soft hit feedback (impact FX may overwrite with stronger crit-aware flash).
          this.setEnemyHitFx(e.id, reduceFx ? 0.08 : 0.12, false)
        }
      } else {
        if (prevAlive) {
          const kind: 'kill' | 'escape' = e.hp <= 0 ? 'kill' : 'escape'
          this.enemyDeathFx.push({ x: e.x, y: e.y, t0: this.vTimeSec, kind })
        }
      }

      this.prevEnemyAlive.set(e.id, e.alive)
      this.prevEnemyHP.set(e.id, e.hp)

      if (!e.alive) continue

      const baseColor = Phaser.Display.Color.HexStringToColor(e.color).color
      const wobble = reduceFx ? 0 : 0.6 * Math.sin(this.vTimeSec * 2.6 + e.id * 0.7)
      let r = 7 + wobble * 0.5

      // Hit "pulse/squash" illusion: brief overshoot in size + ellipse squash.
      // This sells impact without changing sim state.
      const hit = !reduceFx ? this.enemyHitFx.get(e.id) : undefined
      let hitPulse = 0
      let hitCrit = false
      if (hit && hit.untilSec > this.vTimeSec) {
        const dur = hit.crit ? 0.22 : 0.16
        const t = clamp01(1 - (hit.untilSec - this.vTimeSec) / dur) // 0..1
        // Damped overshoot curve: fast pop then settle.
        const pop = Math.sin(Math.min(1, t) * Math.PI)
        hitPulse = pop * pop
        hitCrit = hit.crit
        const amp = hitCrit ? 0.28 : 0.18
        r = r * (1 + amp * hitPulse)
      }

      // Motion trail to make enemies feel faster/more "alive".
      if (drawEnemyTrails && prevPos && prevAlive) {
        const dx = e.x - prevPos.x
        const dy = e.y - prevPos.y
        const dist = Math.hypot(dx, dy)
        const a = clamp01(dist / 10)
        this.fx.lineStyle(3, baseColor, 0.05 * a)
        this.fx.lineBetween(prevPos.x, prevPos.y, e.x, e.y)
        this.fx.fillStyle(baseColor, 0.035 * a)
        this.fx.fillCircle(e.x, e.y, r + 4)
      }

      this.gfx.fillStyle(baseColor, 0.95)
      if (!reduceFx && hitPulse > 0.0001) {
        const squash = hitCrit ? 0.22 : 0.16
        const sx = 1 + squash * hitPulse
        const sy = 1 - 0.5 * squash * hitPulse
        this.gfx.fillEllipse(e.x, e.y, r * 2 * sx, r * 2 * sy)
      } else {
        this.gfx.fillCircle(e.x, e.y, r)
      }

      if (!reduceFx) {
        this.fx.lineStyle(2, baseColor, 0.08)
        this.fx.strokeCircle(e.x, e.y, r + 3.5)
      }

      if (!reduceFx && hit && hit.untilSec > this.vTimeSec) {
        const dur = hit.crit ? 0.22 : 0.16
        const k = clamp01((hit.untilSec - this.vTimeSec) / dur)
        const hc = hit.crit ? lime : cyan
        this.fx.lineStyle(hit.crit ? 3 : 2, hc, 0.17 * k)
        this.fx.strokeCircle(e.x, e.y, r + 5 + (1 - k) * (hit.crit ? 9 : 6))
        this.fx.lineStyle(2, magenta, 0.06 * k)
        this.fx.strokeCircle(e.x, e.y, r + 2 + (1 - k) * (hit.crit ? 6 : 4))

        // Extra hit sparks around the enemy.
        const rays = hit.crit ? 6 : 4
        const baseLen = hit.crit ? 16 : 12
        const phase = (e.id % 19) * 0.41
        for (let i = 0; i < rays; i++) {
          const a = phase + this.vTimeSec * (hit.crit ? 5.0 : 4.2) + (i / rays) * Math.PI * 2
          const len = baseLen * (0.7 + 0.3 * Math.sin(phase + i * 1.9))
          const x0 = e.x + Math.cos(a) * (r + 2)
          const y0 = e.y + Math.sin(a) * (r + 2)
          const x1 = x0 + Math.cos(a) * len * k
          const y1 = y0 + Math.sin(a) * len * k
          this.fx.lineStyle(hit.crit ? 3 : 2, hc, (hit.crit ? 0.12 : 0.10) * k)
          this.fx.lineBetween(x0, y0, x1, y1)
          this.fx.lineStyle(2, magenta, 0.045 * k)
          this.fx.lineBetween(x0, y0, x1, y1)
        }
      }

      // HP bar
      const hpPct = Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHP)))
      const x0 = e.x - 10
      const y0 = e.y - 14
      this.gfx.fillStyle(bg, 0.7)
      this.gfx.fillRect(x0, y0, 20, 4)
      this.gfx.fillStyle(lime, 0.9)
      this.gfx.fillRect(x0, y0, 20 * hpPct, 4)
    }

    // Cleanup hit markers.
    if (this.enemyHitFx.size > 2000) {
      for (const [id, hit] of this.enemyHitFx) {
        if (hit.untilSec < this.vTimeSec - 0.5) this.enemyHitFx.delete(id)
      }
    }

    // Cleanup enemy positions.
    if (this.prevEnemyPos.size > 2400) {
      for (const [id, _] of this.prevEnemyPos) {
        const alive = this.prevEnemyAlive.get(id)
        if (!alive) this.prevEnemyPos.delete(id)
      }
    }

    // Death/escape bursts.
    if (!reduceFx && this.enemyDeathFx.length > 0) {
      const keep: typeof this.enemyDeathFx = []
      for (const fx of this.enemyDeathFx) {
        const age = this.vTimeSec - fx.t0
        if (age < 0 || age > 0.35) continue
        keep.push(fx)

        const k = clamp01(1 - age / 0.35)
        const r = 10 + age * 70
        const primary = fx.kind === 'kill' ? cyan : danger
        const accent = fx.kind === 'kill' ? lime : magenta

        // Multi-ring bloom.
        this.fx.lineStyle(3, primary, 0.16 * k)
        this.fx.strokeCircle(fx.x, fx.y, r)
        this.fx.lineStyle(2, accent, 0.085 * k)
        this.fx.strokeCircle(fx.x, fx.y, r * 0.78)
        this.fx.lineStyle(2, primary, 0.06 * k)
        this.fx.strokeCircle(fx.x, fx.y, r * 1.08)

        // Inner glow + dark core for contrast.
        this.fx.fillStyle(primary, (fx.kind === 'kill' ? 0.020 : 0.030) * k)
        this.fx.fillCircle(fx.x, fx.y, r * 0.58)
        this.fx.fillStyle(0x000000, 0.030 * k)
        this.fx.fillCircle(fx.x, fx.y, r * 0.24)

        // Shard rays.
        const rays = fx.kind === 'kill' ? 7 : 10
        const baseLen = fx.kind === 'kill' ? 24 : 30
        const phase = (Math.floor(fx.x * 0.7 + fx.y * 0.9) % 29) * 0.31
        const spin = (fx.kind === 'kill' ? 1 : -1) * age * 8.0
        for (let i = 0; i < rays; i++) {
          const a = phase + spin + (i / rays) * Math.PI * 2
          const len = baseLen * (0.65 + 0.35 * Math.sin(phase + i * 2.0))
          const x0 = fx.x + Math.cos(a) * (6 + (1 - k) * 3)
          const y0 = fx.y + Math.sin(a) * (6 + (1 - k) * 3)
          const x1 = x0 + Math.cos(a) * len * k
          const y1 = y0 + Math.sin(a) * len * k
          this.fx.lineStyle(3, primary, 0.10 * k)
          this.fx.lineBetween(x0, y0, x1, y1)
          this.fx.lineStyle(2, accent, 0.05 * k)
          this.fx.lineBetween(x0, y0, x1, y1)
        }

        // Escape swirl: a couple of spiral arcs to make escapes feel different.
        if (fx.kind === 'escape') {
          const turns = 2
          const steps = 14
          const swirlR0 = 6
          const swirlR1 = 56
          for (let t = 0; t < turns; t++) {
            const ph = phase + t * 1.3
            this.fx.lineStyle(2, danger, 0.06 * k)
            this.fx.beginPath()
            for (let i = 0; i <= steps; i++) {
              const u = i / steps
              const a = ph + u * Math.PI * 2 * 0.9 + age * 5.2
              const rr = swirlR0 + (swirlR1 - swirlR0) * u
              const x = fx.x + Math.cos(a) * rr
              const y = fx.y + Math.sin(a) * rr
              if (i === 0) this.fx.moveTo(x, y)
              else this.fx.lineTo(x, y)
            }
            this.fx.strokePath()
          }
        }
      }
      this.enemyDeathFx = keep
    }
  }

  private drawRegularPolygon(cx: number, cy: number, radius: number, sides: number, rotationRad = 0) {
    const n = Math.max(3, Math.floor(sides))

    this.gfx.beginPath()
    for (let i = 0; i < n; i++) {
      const a = rotationRad + (i / n) * Math.PI * 2
      const x = cx + Math.cos(a) * radius
      const y = cy + Math.sin(a) * radius
      if (i === 0) this.gfx.moveTo(x, y)
      else this.gfx.lineTo(x, y)
    }
    this.gfx.closePath()
    this.gfx.fillPath()
  }

  private drawTower(args: {
    x: number
    y: number
    t: number
    reduceFx: boolean
    cyan: number
    magenta: number
    lime: number
    text: number
  }) {
    const { x, y, t, reduceFx, cyan, magenta, lime, text } = args

    // Base body (pentagon) with a darker cut-out core for depth.
    this.gfx.fillStyle(magenta, 0.92)
    this.drawRegularPolygon(x, y, 11, 5, -Math.PI / 2)

    this.gfx.fillStyle(0x000000, 0.22)
    this.drawRegularPolygon(x, y + 0.6, 7.5, 5, -Math.PI / 2)

    // Outline + inner core.
    this.gfx.lineStyle(2, text, 0.12)
    this.gfx.strokeCircle(x, y, 8.5)
    this.gfx.fillStyle(lime, 0.22)
    this.gfx.fillCircle(x, y, 4.2)

    if (reduceFx) return

    // Energy fins (animated subtle rotation).
    const rot = t * 1.15
    this.fx.lineStyle(3, cyan, 0.08)
    for (let i = 0; i < 3; i++) {
      const a = rot + (i / 3) * Math.PI * 2
      const x0 = x + Math.cos(a) * 7
      const y0 = y + Math.sin(a) * 7
      const x1 = x + Math.cos(a) * 15
      const y1 = y + Math.sin(a) * 15
      this.fx.lineBetween(x0, y0, x1, y1)
    }

    // Outer glow ring.
    const glowR = 14 + 1.5 * (0.5 + 0.5 * Math.sin(t * 2.0 + 0.4))
    this.fx.lineStyle(2, magenta, 0.12)
    this.fx.strokeCircle(x, y, glowR)

    // Extra glow on recent shots.
    if (t < this.towerPulseUntilSec) {
      const k = clamp01((this.towerPulseUntilSec - t) / 0.18)
      this.fx.lineStyle(2, lime, 0.10 * k)
      this.fx.strokeCircle(x, y, glowR + 7 + (1 - k) * 10)
      this.fx.fillStyle(lime, 0.018 * k)
      this.fx.fillCircle(x, y, glowR + 6)
    }

    // Orbiting accent dot.
    const oa = t * 2.6
    const ox = x + Math.cos(oa) * 12.5
    const oy = y + Math.sin(oa) * 12.5
    this.fx.fillStyle(cyan, 0.18)
    this.fx.fillCircle(ox, oy, 3.2)
    this.fx.fillStyle(cyan, 0.06)
    this.fx.fillCircle(ox, oy, 7.0)
  }


  private setEnemyHitFx(enemyId: number, durSec: number, crit: boolean) {
    const id = Math.max(1, Math.floor(enemyId))
    const untilSec = this.vTimeSec + Math.max(0.04, durSec)
    const prev = this.enemyHitFx.get(id)
    if (!prev) {
      this.enemyHitFx.set(id, { untilSec, crit })
      return
    }

    this.enemyHitFx.set(id, {
      untilSec: Math.max(prev.untilSec, untilSec),
      crit: prev.crit || crit,
    })
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 1
  return Math.max(0, Math.min(1, x))
}

function hexTo0x(hex: string): number {
  // Accepts '#RRGGBB' or 'RRGGBB'.
  return Phaser.Display.Color.HexStringToColor(hex).color
}
