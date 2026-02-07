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

  private prevEnemyHP = new Map<number, number>()
  private prevEnemyAlive = new Map<number, boolean>()
  private enemyHitUntilSec = new Map<number, number>()

  private enemyDeathFx: Array<{ x: number; y: number; t0: number; kind: 'kill' | 'escape' }> = []

  private prevProjectilePos = new Map<number, { x: number; y: number }>()
  private prevProjectileAlive = new Map<number, boolean>()
  private muzzleFxUntilSec = 0
  private prevBaseHP = Number.NaN

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

    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.engine.setViewport({ width: gameSize.width, height: gameSize.height })
    })
  }

  update(_time: number, deltaMs: number) {
    const deltaSec = Math.min(0.25, deltaMs / 1000)
    this.vTimeSec += deltaSec
    this.accumulator += deltaSec

    while (this.accumulator >= this.fixedDt) {
      this.engine.tick(this.fixedDt)
      this.accumulator -= this.fixedDt
    }

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
    this.gfx.fillStyle(magenta, 0.95)
    this.drawRegularPolygon(towerX, towerY, 10, 5, -Math.PI / 2)

    if (!reduceFx) {
      const glowR = 14 + 1.5 * (0.5 + 0.5 * Math.sin(this.vTimeSec * 2.0 + 0.4))
      this.fx.lineStyle(2, magenta, 0.12)
      this.fx.strokeCircle(towerX, towerY, glowR)
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
        this.cameras.main.shake(90, 0.002)
      }
    }
    this.prevBaseHP = pub.state.baseHP

    // Range ring (subtle)
    const rangeAlpha = reduceFx ? 0.16 : 0.12 + 0.06 * (0.5 + 0.5 * Math.sin(this.vTimeSec * 1.15))
    this.gfx.lineStyle(1, magenta, rangeAlpha)
    this.gfx.strokeCircle(towerX, towerY, pub.tower.range)

    // Projectiles
    if (pub.projectiles.length > 0) {
      this.gfx.fillStyle(cyan, 0.9)
      let shotThisFrame = false
      for (const p of pub.projectiles) {
        const wasAlive = this.prevProjectileAlive.get(p.id) ?? false
        this.prevProjectileAlive.set(p.id, p.alive)

        const prev = this.prevProjectilePos.get(p.id)
        this.prevProjectilePos.set(p.id, { x: p.x, y: p.y })

        if (!p.alive) continue

        if (!wasAlive) shotThisFrame = true

        if (!reduceFx && prev && wasAlive) {
          // Additive trail.
          this.fx.lineStyle(2, cyan, 0.12)
          this.fx.lineBetween(prev.x, prev.y, p.x, p.y)
          this.fx.fillStyle(cyan, 0.06)
          this.fx.fillCircle(p.x, p.y, 5.5)
        }

        this.gfx.fillCircle(p.x, p.y, 2.5)
      }

      if (!reduceFx && shotThisFrame) this.muzzleFxUntilSec = Math.max(this.muzzleFxUntilSec, this.vTimeSec + 0.09)
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

    // Muzzle flash when new projectile(s) appear.
    if (!reduceFx && this.vTimeSec < this.muzzleFxUntilSec) {
      const k = clamp01((this.muzzleFxUntilSec - this.vTimeSec) / 0.09)
      const r = 10 + (1 - k) * 18
      this.fx.lineStyle(2, cyan, 0.14 * k)
      this.fx.strokeCircle(towerX, towerY, r)
    }

    // Enemies
    for (const e of pub.enemies) {
      const prevAlive = this.prevEnemyAlive.get(e.id) ?? false
      const prevHP = this.prevEnemyHP.get(e.id)

      // Detect damage and transitions.
      if (e.alive) {
        if (typeof prevHP === 'number' && e.hp < prevHP - 1e-9) {
          this.enemyHitUntilSec.set(e.id, this.vTimeSec + (reduceFx ? 0.08 : 0.14))
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
      const r = 7 + wobble * 0.5
      this.gfx.fillStyle(baseColor, 0.95)
      this.gfx.fillCircle(e.x, e.y, r)

      if (!reduceFx) {
        this.fx.lineStyle(2, baseColor, 0.08)
        this.fx.strokeCircle(e.x, e.y, r + 3.5)
      }

      const hitUntil = this.enemyHitUntilSec.get(e.id) ?? -1
      if (!reduceFx && hitUntil > this.vTimeSec) {
        const k = clamp01((hitUntil - this.vTimeSec) / 0.14)
        this.fx.lineStyle(2, text, 0.18 * k)
        this.fx.strokeCircle(e.x, e.y, r + 5 + (1 - k) * 6)
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
    if (this.enemyHitUntilSec.size > 2000) {
      for (const [id, until] of this.enemyHitUntilSec) {
        if (until < this.vTimeSec - 0.5) this.enemyHitUntilSec.delete(id)
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
        const c = fx.kind === 'kill' ? cyan : danger
        this.fx.lineStyle(2, c, 0.16 * k)
        this.fx.strokeCircle(fx.x, fx.y, r)
        this.fx.fillStyle(c, 0.02 * k)
        this.fx.fillCircle(fx.x, fx.y, r * 0.55)
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
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 1
  return Math.max(0, Math.min(1, x))
}

function hexTo0x(hex: string): number {
  // Accepts '#RRGGBB' or 'RRGGBB'.
  return Phaser.Display.Color.HexStringToColor(hex).color
}
