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

    this.gfx.clear()

    // Background grid
    this.gfx.lineStyle(1, 0x22f5ff, 0.06)
    const grid = 48
    for (let x = 0; x <= w; x += grid) this.gfx.lineBetween(x, 0, x, h)
    for (let y = 0; y <= h; y += grid) this.gfx.lineBetween(0, y, w, y)

    // Arena bounds (full width/height playfield)
    const b = pub.arena.bounds
    this.gfx.lineStyle(2, 0x00ffff, 0.14)
    this.gfx.strokeRect(b.left, b.top, b.right - b.left, b.bottom - b.top)

    // Base zone (escape trigger)
    const half = pub.arena.baseHalfSize
    this.gfx.lineStyle(2, 0xff00ff, 0.2)
    this.gfx.strokeCircle(pub.arena.center.x, pub.arena.center.y, half)

    // Tower
    this.gfx.fillStyle(0xff2bd6, 0.95)
    this.drawRegularPolygon(pub.tower.pos.x, pub.tower.pos.y, 10, 5, -Math.PI / 2)

    // Base HP (shown as a bar above the tower/base)
    const maxHP = Math.max(1, calcBaseHPMax(pub.state, this.cfg))
    const hpPct = clamp01(pub.state.baseHP / maxHP)
    const barW = 58
    const barH = 7
    const x0 = pub.tower.pos.x - barW / 2
    const y0 = pub.tower.pos.y - 18
    this.gfx.fillStyle(0x070812, 0.65)
    this.gfx.fillRoundedRect(x0, y0, barW, barH, 3)
    this.gfx.lineStyle(1, 0x22f5ff, 0.22)
    this.gfx.strokeRoundedRect(x0, y0, barW, barH, 3)
    this.gfx.fillStyle(0xb6ff2e, 0.85)
    this.gfx.fillRoundedRect(x0 + 1, y0 + 1, Math.max(0, (barW - 2) * hpPct), barH - 2, 2)

    // Range ring (subtle)
    this.gfx.lineStyle(1, 0xff2bd6, 0.18)
    this.gfx.strokeCircle(pub.tower.pos.x, pub.tower.pos.y, pub.tower.range)

    // Projectiles
    if (pub.projectiles.length > 0) {
      this.gfx.fillStyle(0x00ffff, 0.9)
      for (const p of pub.projectiles) {
        if (!p.alive) continue
        this.gfx.fillCircle(p.x, p.y, 2.5)
      }
    }

    // Enemies
    for (const e of pub.enemies) {
      if (!e.alive) continue
      const color = Phaser.Display.Color.HexStringToColor(e.color).color
      this.gfx.fillStyle(color, 0.95)
      this.gfx.fillCircle(e.x, e.y, 7)

      // HP bar
      const hpPct = Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHP)))
      const x0 = e.x - 10
      const y0 = e.y - 14
      this.gfx.fillStyle(0x070812, 0.7)
      this.gfx.fillRect(x0, y0, 20, 4)
      this.gfx.fillStyle(0xb6ff2e, 0.9)
      this.gfx.fillRect(x0, y0, 20 * hpPct, 4)
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
