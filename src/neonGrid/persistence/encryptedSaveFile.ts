import type { GameConfig, GameState } from '../types'
import { buildSaveSnapshot, rehydrateImportedState } from './save'

type EncryptedSaveFileV1 = {
  t: 'neon-grid-save'
  v: 1
  kdf: 'HKDF-SHA-256'
  alg: 'AES-256-GCM'
  saltB64: string
  ivB64: string
  ctB64: string
}

const FILE_TAG = 'neon-grid-save'
const FILE_VERSION = 1 as const

// NOTE: This is meant to prevent casual tampering / reading.
// A determined user can still reverse-engineer a client-side key.
const APP_SECRET = 'NEON_GRID_SAVE_FILE_SECRET_V1'

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength)
  out.set(bytes)
  return out.buffer
}

function b64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function b64Decode(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

async function deriveAesKey(salt: Uint8Array): Promise<CryptoKey> {
  if (!crypto?.subtle) throw new Error('WebCrypto is not available in this environment')

  const secretBytes = new TextEncoder().encode(APP_SECRET)
  const ikm = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey'])

  const saltBuf = toArrayBuffer(salt)

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBuf,
      info: new TextEncoder().encode('neon-grid-save-file'),
    },
    ikm,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function exportEncryptedSaveString(config: GameConfig, state: GameState): Promise<string> {
  const nowUTC = Date.now()
  const snapshot = buildSaveSnapshot(config, state, nowUTC)

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(salt)

  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot))
  const aad = new TextEncoder().encode(`${FILE_TAG}:${FILE_VERSION}`)

  const ivBuf = toArrayBuffer(iv)
  const aadBuf = toArrayBuffer(aad)

  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBuf, additionalData: aadBuf }, key, plaintext)
  const ct = new Uint8Array(ctBuf)

  const file: EncryptedSaveFileV1 = {
    t: FILE_TAG,
    v: 1,
    kdf: 'HKDF-SHA-256',
    alg: 'AES-256-GCM',
    saltB64: b64Encode(salt),
    ivB64: b64Encode(iv),
    ctB64: b64Encode(ct),
  }

  return JSON.stringify(file)
}

export async function exportEncryptedSaveFile(config: GameConfig, state: GameState): Promise<Blob> {
  const text = await exportEncryptedSaveString(config, state)
  return new Blob([text], { type: 'application/json' })
}

export async function importEncryptedSaveFile(config: GameConfig, fileText: string): Promise<GameState> {
  let parsed: any
  try {
    parsed = JSON.parse(fileText)
  } catch {
    throw new Error('Invalid save file: not JSON')
  }

  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid save file')
  if (parsed.t !== FILE_TAG) throw new Error('Invalid save file: unknown tag')
  if (parsed.v !== FILE_VERSION) throw new Error('Invalid save file: unsupported version')

  const salt = b64Decode(String(parsed.saltB64 ?? ''))
  const iv = b64Decode(String(parsed.ivB64 ?? ''))
  const ct = b64Decode(String(parsed.ctB64 ?? ''))

  if (salt.length < 8) throw new Error('Invalid save file: bad salt')
  if (iv.length !== 12) throw new Error('Invalid save file: bad iv')
  if (ct.length < 16) throw new Error('Invalid save file: bad ciphertext')

  const key = await deriveAesKey(salt)
  const aad = new TextEncoder().encode(`${FILE_TAG}:${FILE_VERSION}`)

  const ivBuf = toArrayBuffer(iv)
  const aadBuf = toArrayBuffer(aad)

  const ctBuf = toArrayBuffer(ct)

  let ptBuf: ArrayBuffer
  try {
    ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf, additionalData: aadBuf }, key, ctBuf)
  } catch {
    throw new Error('Save file could not be decrypted (wrong/modified file)')
  }

  const ptText = new TextDecoder().decode(ptBuf)
  let saveObj: any
  try {
    saveObj = JSON.parse(ptText)
  } catch {
    throw new Error('Decrypted payload is not valid JSON')
  }

  if (!saveObj || typeof saveObj !== 'object') throw new Error('Decrypted payload is invalid')

  const nowUTC = Date.now()
  return rehydrateImportedState(config, saveObj as GameState, nowUTC)
}
