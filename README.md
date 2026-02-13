# NEON GRID — Deterministic Idle Tower Defense (Phaser 3)

Web-first (desktop + mobile) deterministik idle tower defense prototipi.

## Run

- Install: `npm i`
- Dev: `npm run dev`
- Build: `npm run build`
- Preview: `npm run preview`

## Background music

- Put your music file at `public/gamemusic.mp3`.
- The game preloads it as Phaser audio key `bgm` and plays it in a loop.

## Save / Load (Encrypted localStorage)

The game stores progress in your browser via encrypted `localStorage`.

- If you clear browser data (or uninstall the browser), your progress will be lost.
- There is no cloud/database sync.

## Non‑negotiables

- RNG yok (oyun mantığında rastgelelik kullanılmıyor)
- Her wave tam `T` saniye
- Kill Ratio cezası: ödül çarpanı düşer + opsiyonel escape damage
- Offline progress deterministik timestamp farkıyla hesaplanır

## Docs

- Tasarım + matematik + UI + mimari: [docs/design-spec-tr.md](docs/design-spec-tr.md)
- Özgün modüller listesi: [docs/modules-40.md](docs/modules-40.md)

## Code map

- Deterministik fonksiyonlar: [src/neonGrid/sim/deterministic.ts](src/neonGrid/sim/deterministic.ts)
- Offline progress: [src/neonGrid/sim/offline.ts](src/neonGrid/sim/offline.ts)
- Sim engine: [src/neonGrid/sim/SimEngine.ts](src/neonGrid/sim/SimEngine.ts)
- DOM UI state machine: [src/neonGrid/ui/uiStateMachine.ts](src/neonGrid/ui/uiStateMachine.ts)
- Phaser boot/game scenes: [src/neonGrid/phaser/scenes](src/neonGrid/phaser/scenes)
