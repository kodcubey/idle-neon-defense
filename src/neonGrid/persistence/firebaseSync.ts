import type { GameState } from '../types'
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  deleteUser,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth'
import { getFirestore, doc, getDoc, serverTimestamp, runTransaction } from 'firebase/firestore'

export type MetaSaveV1 = {
  v: 1
  points: number
  prestigePoints: number
  rewardedAdNextEligibleUTC?: number
  towerMetaUpgrades?: GameState['towerMetaUpgrades']
  settings: GameState['settings']
  stats: GameState['stats']
  modulesUnlocked: GameState['modulesUnlocked']
  moduleLevels: GameState['moduleLevels']
  modulesEquipped: GameState['modulesEquipped']
  moduleSlotsUnlocked?: number
}

export function extractMetaFromState(state: GameState): MetaSaveV1 {
  return {
    v: 1,
    points: typeof state.points === 'number' && Number.isFinite(state.points) ? Math.max(0, Math.floor(state.points)) : 0,
    prestigePoints: typeof state.prestigePoints === 'number' && Number.isFinite(state.prestigePoints) ? Math.max(0, Math.floor(state.prestigePoints)) : 0,
    rewardedAdNextEligibleUTC: state.rewardedAdNextEligibleUTC,
    towerMetaUpgrades: state.towerMetaUpgrades ? { ...state.towerMetaUpgrades } : undefined,
    settings: { ...state.settings },
    stats: { ...state.stats },
    modulesUnlocked: { ...state.modulesUnlocked },
    moduleLevels: { ...state.moduleLevels },
    modulesEquipped: { ...state.modulesEquipped },
    moduleSlotsUnlocked: state.moduleSlotsUnlocked,
  }
}

export function applyMetaToState(current: GameState, meta: MetaSaveV1): GameState {
  const mergedLevels = { ...current.moduleLevels, ...meta.moduleLevels }
  for (const [id, v] of Object.entries(mergedLevels)) {
    mergedLevels[id] = typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1
  }

  const metaPoints = typeof meta.points === 'number' && Number.isFinite(meta.points) ? Math.max(0, meta.points) : null
  const metaPrestige = typeof meta.prestigePoints === 'number' && Number.isFinite(meta.prestigePoints) ? Math.max(0, meta.prestigePoints) : null
  const metaRewardNext =
    typeof meta.rewardedAdNextEligibleUTC === 'number' && Number.isFinite(meta.rewardedAdNextEligibleUTC) ? Math.max(0, meta.rewardedAdNextEligibleUTC) : null

  const nextMetaUpgrades = (() => {
    const base = current.towerMetaUpgrades
    const incoming = meta.towerMetaUpgrades
    if (!incoming || typeof incoming !== 'object') return base
    const merged: any = { ...base }
    for (const [k, v] of Object.entries(incoming as any)) {
      const inc = typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1
      const cur = merged[k]
      const curL = typeof cur === 'number' && Number.isFinite(cur) ? Math.max(1, Math.floor(cur)) : 1
      merged[k] = Math.max(curL, inc)
    }
    return merged as GameState['towerMetaUpgrades']
  })()

  return {
    ...current,
    // Points are spendable; applyCloudMetaToState() decides whether to trust cloud.
    points: metaPoints == null ? current.points : Math.max(0, Math.floor(metaPoints)),
    prestigePoints: metaPrestige == null ? current.prestigePoints : Math.max(current.prestigePoints, metaPrestige),
    rewardedAdNextEligibleUTC: metaRewardNext == null ? current.rewardedAdNextEligibleUTC : Math.max(current.rewardedAdNextEligibleUTC, metaRewardNext),
    towerMetaUpgrades: nextMetaUpgrades,
    settings: { ...current.settings, ...meta.settings, quality: 'high' },
    stats: { ...current.stats, ...meta.stats },
    modulesUnlocked: { ...current.modulesUnlocked, ...meta.modulesUnlocked },
    moduleLevels: mergedLevels,
    modulesEquipped: { ...current.modulesEquipped, ...meta.modulesEquipped },
    moduleSlotsUnlocked:
      typeof meta.moduleSlotsUnlocked === 'number' && Number.isFinite(meta.moduleSlotsUnlocked)
        ? Math.max(1, Math.floor(meta.moduleSlotsUnlocked))
        : current.moduleSlotsUnlocked,
  }
}

export function applyCloudMetaToState(current: GameState, cloud: CloudMeta): GameState {
  const next = applyMetaToState(current, cloud.meta)

  const cloudTs = typeof cloud.clientUpdatedAtUTC === 'number' && Number.isFinite(cloud.clientUpdatedAtUTC) ? cloud.clientUpdatedAtUTC : 0
  const localTs = typeof current.lastSaveTimestampUTC === 'number' && Number.isFinite(current.lastSaveTimestampUTC) ? current.lastSaveTimestampUTC : 0

  // Points (Paladyum) are spendable; cloud can legitimately reduce them.
  // Only trust cloud points when the cloud doc is at least as new as the local snapshot.
  if (cloudTs >= localTs) {
    const p = cloud.meta?.points
    if (typeof p === 'number' && Number.isFinite(p)) {
      ;(next as any).points = Math.max(0, Math.floor(p))
    }
  }

  return next
}

type SaveDocV1 = {
  v: 1
  game: 'neon-grid'
  clientUpdatedAtUTC: number
  updatedAt?: unknown
  meta: MetaSaveV1
}

export type FirebaseSyncStatus = {
  configured: boolean
  signedIn: boolean
  email: string | null
  uid: string | null
}

export type CloudMeta = {
  meta: MetaSaveV1
  clientUpdatedAtUTC: number
}

function sanitizeMetaIntegers(meta: MetaSaveV1): { meta: MetaSaveV1; changed: boolean } {
  const nextPoints = typeof meta.points === 'number' && Number.isFinite(meta.points) ? Math.max(0, Math.floor(meta.points)) : 0
  const nextPrestige =
    typeof meta.prestigePoints === 'number' && Number.isFinite(meta.prestigePoints) ? Math.max(0, Math.floor(meta.prestigePoints)) : 0
  const changed = nextPoints !== meta.points || nextPrestige !== meta.prestigePoints
  if (!changed) return { meta, changed: false }
  return {
    meta: {
      ...meta,
      points: nextPoints,
      prestigePoints: nextPrestige,
    },
    changed: true,
  }
}

export type FirebaseSync = {
  getStatus: () => FirebaseSyncStatus
  onAuthChanged: (cb: (s: FirebaseSyncStatus) => void) => () => void
  getUsername: () => Promise<string | null>
  signUpUsernameEmailPassword: (username: string, email: string, password: string) => Promise<void>
  signInUsernameOrEmail: (identifier: string, password: string) => Promise<void>
  signUpEmail: (email: string, password: string) => Promise<void>
  signInEmail: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  downloadMeta: () => Promise<CloudMeta | null>
  uploadMetaFromState: (snapshot: GameState) => Promise<void>
}

function normalizeUsername(input: string): string {
  return input.trim().toLowerCase()
}

function env(name: string): string {
  return String((import.meta.env as any)[name] ?? '').trim()
}

function isConfigured(): boolean {
  return (
    env('VITE_FIREBASE_API_KEY').length > 0 &&
    env('VITE_FIREBASE_AUTH_DOMAIN').length > 0 &&
    env('VITE_FIREBASE_PROJECT_ID').length > 0 &&
    env('VITE_FIREBASE_APP_ID').length > 0
  )
}

function initAppIfNeeded(): FirebaseApp {
  const existing = getApps()[0]
  if (existing) return existing

  if (!isConfigured()) {
    // Create a dummy app is not useful; fail early so UI can show a clear message.
    throw new Error('Firebase is not configured. Add VITE_FIREBASE_* env vars.')
  }

  return initializeApp({
    apiKey: env('VITE_FIREBASE_API_KEY'),
    authDomain: env('VITE_FIREBASE_AUTH_DOMAIN'),
    projectId: env('VITE_FIREBASE_PROJECT_ID'),
    appId: env('VITE_FIREBASE_APP_ID'),
    storageBucket: env('VITE_FIREBASE_STORAGE_BUCKET') || undefined,
    messagingSenderId: env('VITE_FIREBASE_MESSAGING_SENDER_ID') || undefined,
  })
}

export function createFirebaseSync(): FirebaseSync {
  let app: FirebaseApp | null = null
  let user: User | null = null
  let cachedUsername: string | null = null
  let cachedUsernameUid: string | null = null

  const getOrInit = () => {
    if (!app) app = initAppIfNeeded()
    return app
  }

  const auth = () => getAuth(getOrInit())
  const db = () => getFirestore(getOrInit())

  const status = (): FirebaseSyncStatus => ({
    configured: isConfigured(),
    signedIn: !!user,
    email: user?.email ?? null,
    uid: user?.uid ?? null,
  })

  const saveDocRef = (uid: string) => doc(db(), 'saves', uid)
  const usernameDocRef = (username: string) => doc(db(), 'usernames', normalizeUsername(username))
  const userDocRef = (uid: string) => doc(db(), 'users', uid)

  return {
    getStatus: status,

    getUsername: async () => {
      if (!isConfigured()) throw new Error('Firebase not configured')
      if (!user) throw new Error('Not signed in')

      if (cachedUsernameUid === user.uid && cachedUsername) return cachedUsername

      const snap = await getDoc(userDocRef(user.uid))
      const data = snap.exists() ? (snap.data() as { username?: unknown }) : null
      const uname = typeof data?.username === 'string' ? data.username : null
      cachedUsername = uname
      cachedUsernameUid = user.uid
      return uname
    },

    onAuthChanged: (cb) => {
      if (!isConfigured()) {
        cb(status())
        return () => {}
      }

      const unsub = onAuthStateChanged(
        auth(),
        (u) => {
          user = u
          if (!u) {
            cachedUsername = null
            cachedUsernameUid = null
          }
          cb(status())
        },
        () => {
          user = null
          cachedUsername = null
          cachedUsernameUid = null
          cb(status())
        },
      )

      // Immediately emit current.
      user = auth().currentUser
      cb(status())
      return unsub
    },

    signUpUsernameEmailPassword: async (username, email, password) => {
      if (!isConfigured()) throw new Error('Firebase not configured')
      const uname = normalizeUsername(username)
      if (!uname) throw new Error('Username is required')
      if (!email.trim()) throw new Error('Email is required')

      const created = await createUserWithEmailAndPassword(auth(), email.trim(), password)
      user = created.user

      try {
        await runTransaction(db(), async (tx) => {
          const uref = usernameDocRef(uname)
          const existing = await tx.get(uref)
          if (existing.exists()) throw new Error('Username already taken')

          tx.set(
            uref,
            {
              v: 1,
              uid: created.user.uid,
              email: email.trim(),
              username: uname,
              createdAt: serverTimestamp(),
            },
            { merge: true },
          )

          tx.set(
            userDocRef(created.user.uid),
            {
              v: 1,
              uid: created.user.uid,
              email: email.trim(),
              username: uname,
              createdAt: serverTimestamp(),
            },
            { merge: true },
          )
        })
      } catch (e) {
        // Avoid leaving an orphaned auth user if username is taken.
        try {
          await deleteUser(created.user)
        } catch {
          // ignore
        }
        user = null
        throw e
      }
    },

    signInUsernameOrEmail: async (identifier, password) => {
      if (!isConfigured()) throw new Error('Firebase not configured')
      const id = identifier.trim()
      if (!id) throw new Error('Username or email is required')

      let email = id
      if (!id.includes('@')) {
        const uname = normalizeUsername(id)
        const snap = await getDoc(usernameDocRef(uname))
        if (!snap.exists()) throw new Error('Username not found')
        const data = snap.data() as { email?: string }
        if (!data.email) throw new Error('Username mapping is invalid')
        email = data.email
      }

      const res = await signInWithEmailAndPassword(auth(), email, password)
      user = res.user
    },

    signUpEmail: async (email, password) => {
      if (!isConfigured()) throw new Error('Firebase not configured')
      const res = await createUserWithEmailAndPassword(auth(), email, password)
      user = res.user
    },

    signInEmail: async (email, password) => {
      if (!isConfigured()) throw new Error('Firebase not configured')
      const res = await signInWithEmailAndPassword(auth(), email, password)
      user = res.user
    },

    signOut: async () => {
      if (!isConfigured()) return
      await fbSignOut(auth())
      user = null
    },

    downloadMeta: async () => {
      if (!isConfigured()) throw new Error('Firebase not configured')
      if (!user) throw new Error('Not signed in')

      const snap = await getDoc(saveDocRef(user.uid))
      if (!snap.exists()) return null

      const data = snap.data() as Partial<SaveDocV1> & { state?: unknown; meta?: unknown }
      if (data.v !== 1) throw new Error('Unsupported save version')
      if (data.game !== 'neon-grid') throw new Error('Invalid save document')

      const ts = typeof data.clientUpdatedAtUTC === 'number' && Number.isFinite(data.clientUpdatedAtUTC) ? data.clientUpdatedAtUTC : 0

      // New format: meta-only.
      if (data.meta && typeof data.meta === 'object') {
        const raw = data.meta as MetaSaveV1
        const sanitized = sanitizeMetaIntegers(raw)

        // If cloud contains fractional Paladyum, fix it in-place (guarded by timestamp).
        if (sanitized.changed) {
          try {
            await runTransaction(db(), async (tx) => {
              const ref = saveDocRef(user!.uid)
              const cur = await tx.get(ref)
              if (!cur.exists()) return
              const curData = cur.data() as Partial<SaveDocV1>
              const curTs =
                typeof curData.clientUpdatedAtUTC === 'number' && Number.isFinite(curData.clientUpdatedAtUTC) ? curData.clientUpdatedAtUTC : 0
              if (curTs !== ts) return
              const curMeta = (curData as any)?.meta
              if (!curMeta || typeof curMeta !== 'object') return

              tx.set(
                ref,
                {
                  meta: sanitized.meta,
                  updatedAt: serverTimestamp(),
                } as Partial<SaveDocV1>,
                { merge: true },
              )
            })
          } catch {
            // ignore
          }
        }

        return { meta: sanitized.meta, clientUpdatedAtUTC: ts }
      }

      // Back-compat: if an older doc stored full state, derive meta from it.
      if (data.state && typeof data.state === 'object') {
        return { meta: extractMetaFromState(data.state as GameState), clientUpdatedAtUTC: ts }
      }

      throw new Error('Invalid save payload')
    },

    uploadMetaFromState: async (snapshot) => {
      if (!isConfigured()) throw new Error('Firebase not configured')
      if (!user) throw new Error('Not signed in')

      const meta = extractMetaFromState(snapshot)

      const payload: SaveDocV1 = {
        v: 1,
        game: 'neon-grid',
        clientUpdatedAtUTC: Date.now(),
        updatedAt: serverTimestamp(),
        meta,
      }

      // Prevent stale local snapshots from overwriting newer cloud data.
      await runTransaction(db(), async (tx) => {
        const ref = saveDocRef(user!.uid)
        const snap = await tx.get(ref)

        let existingRewardNext: number | null = null
        let existingUpdatedAt: number | null = null
        if (snap.exists()) {
          const data = snap.data() as Partial<SaveDocV1>
          const rn = (data as any)?.meta?.rewardedAdNextEligibleUTC
          if (typeof rn === 'number' && Number.isFinite(rn)) existingRewardNext = Math.max(0, rn)

          const u = (data as any)?.clientUpdatedAtUTC
          if (typeof u === 'number' && Number.isFinite(u)) existingUpdatedAt = u
        }

        if (existingUpdatedAt != null && existingUpdatedAt > payload.clientUpdatedAtUTC) return

        if (existingRewardNext != null) {
          const cur = payload.meta.rewardedAdNextEligibleUTC
          const next = typeof cur === 'number' && Number.isFinite(cur) ? Math.max(0, cur) : 0
          payload.meta.rewardedAdNextEligibleUTC = Math.max(next, existingRewardNext)
        }

        tx.set(ref, payload, { merge: true })
      })
    },
  }
}
