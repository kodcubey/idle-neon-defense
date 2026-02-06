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
import { getFirestore, doc, getDoc, setDoc, serverTimestamp, runTransaction } from 'firebase/firestore'

export type MetaSaveV1 = {
  v: 1
  points: number
  prestigePoints: number
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
    points: state.points,
    prestigePoints: state.prestigePoints,
    settings: { ...state.settings },
    stats: { ...state.stats },
    modulesUnlocked: { ...state.modulesUnlocked },
    moduleLevels: { ...state.moduleLevels },
    modulesEquipped: { ...state.modulesEquipped },
    moduleSlotsUnlocked: state.moduleSlotsUnlocked,
  }
}

export function applyMetaToState(current: GameState, meta: MetaSaveV1): GameState {
  return {
    ...current,
    points: typeof meta.points === 'number' ? meta.points : current.points,
    prestigePoints: typeof meta.prestigePoints === 'number' ? meta.prestigePoints : current.prestigePoints,
    settings: { ...current.settings, ...meta.settings, quality: 'high' },
    stats: { ...current.stats, ...meta.stats },
    modulesUnlocked: { ...current.modulesUnlocked, ...meta.modulesUnlocked },
    moduleLevels: { ...current.moduleLevels, ...meta.moduleLevels },
    modulesEquipped: { ...current.modulesEquipped, ...meta.modulesEquipped },
    moduleSlotsUnlocked:
      typeof meta.moduleSlotsUnlocked === 'number' && Number.isFinite(meta.moduleSlotsUnlocked)
        ? Math.max(1, Math.floor(meta.moduleSlotsUnlocked))
        : current.moduleSlotsUnlocked,
  }
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

export type FirebaseSync = {
  getStatus: () => FirebaseSyncStatus
  onAuthChanged: (cb: (s: FirebaseSyncStatus) => void) => () => void
  getUsername: () => Promise<string | null>
  signUpUsernameEmailPassword: (username: string, email: string, password: string) => Promise<void>
  signInUsernameOrEmail: (identifier: string, password: string) => Promise<void>
  signUpEmail: (email: string, password: string) => Promise<void>
  signInEmail: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  downloadMeta: () => Promise<MetaSaveV1 | null>
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

      // New format: meta-only.
      if (data.meta && typeof data.meta === 'object') {
        return data.meta as MetaSaveV1
      }

      // Back-compat: if an older doc stored full state, derive meta from it.
      if (data.state && typeof data.state === 'object') {
        return extractMetaFromState(data.state as GameState)
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

      await setDoc(saveDocRef(user.uid), payload, { merge: true })
    },
  }
}
