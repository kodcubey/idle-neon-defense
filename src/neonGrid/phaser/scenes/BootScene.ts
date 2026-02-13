import Phaser from 'phaser'

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot')
  }

  preload() {
    // Place the file at: /public/gamemusic.mp3 (served at /gamemusic.mp3)
    // Use absolute URL from Vite public root to avoid relative-path issues.
    this.load.audio('bgm', ['/gamemusic.mp3'])
  }

  create() {
    // No asset preload required for the deterministic prototype.
    this.scene.start('Game')
  }
}
