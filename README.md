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

## Cloud Save (Firebase)

Client-only cloud sync is implemented with Firebase Auth + Firestore.

- Create a Firebase project
- Enable **Authentication** (Email/Password)
- Create a **Firestore** database
- Add a Web App in Firebase to get config values

Create `.env.local`:

- `VITE_FIREBASE_API_KEY=...`
- `VITE_FIREBASE_AUTH_DOMAIN=...`
- `VITE_FIREBASE_PROJECT_ID=...`
- `VITE_FIREBASE_APP_ID=...`

Optional:

- `VITE_FIREBASE_STORAGE_BUCKET=...`
- `VITE_FIREBASE_MESSAGING_SENDER_ID=...`

In-game: **Settings** → **Cloud Save (Firebase)**.
Auto-upload runs when the run ends (game over).

### Firestore rules

If you see `Missing or insufficient permissions`, your Firestore security rules are denying access.

- Open Firebase Console → Firestore Database → Rules
- Paste the contents of [firestore.rules](firestore.rules)

Note: Username login (client-only) requires reading `/usernames/{username}` before auth.
The rules allow `get` but deny `list` to reduce enumeration.

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
