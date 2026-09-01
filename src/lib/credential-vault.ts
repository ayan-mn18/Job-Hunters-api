import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { env } from '../config/env.js'
import { db } from '../db/client.js'
import { userKeys } from '../db/schema.js'
import { serviceUnavailable } from './errors.js'

/**
 * Envelope encryption for stored portal credentials and browser sessions.
 *
 * Two layers. The deployment holds one master key (`PORTAL_CREDENTIALS_KEY`);
 * each user gets their own randomly generated data key, stored in `user_keys`
 * wrapped by that master key. Credentials are encrypted under the user's data
 * key, never under the master key directly.
 *
 * Why: with a single key, one leak exposes every user's LinkedIn session, and
 * rotating that key means decrypting and re-encrypting every secret in the
 * database. Per-user keys contain the blast radius, and make rotation a re-wrap
 * of one small table.
 *
 * Version 1 envelopes — written before this existed, and still sitting in
 * `portal_accounts` for every currently connected account — are encrypted
 * directly under the master key. They still decrypt. Nothing new is written in
 * that format, and a v1 value is upgraded to v2 the next time it is written.
 */

interface Envelope {
  /** 1: sealed under the master key. 2: sealed under the user's data key. */
  v: 1 | 2
  iv: string
  tag: string
  ciphertext: string
}

function masterKey(): Buffer {
  if (!env.PORTAL_CREDENTIALS_KEY) {
    throw serviceUnavailable(
      'Portal credential storage is not configured. Set PORTAL_CREDENTIALS_KEY.',
    )
  }
  const decoded = Buffer.from(env.PORTAL_CREDENTIALS_KEY, 'base64url')
  if (decoded.length !== 32) {
    throw serviceUnavailable('PORTAL_CREDENTIALS_KEY must decode to exactly 32 bytes.')
  }
  return decoded
}

function seal(key: Buffer, plaintext: Buffer, version: 1 | 2): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const envelope: Envelope = {
    v: version,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
  return JSON.stringify(envelope)
}

function open(key: Buffer, envelope: Envelope): Buffer {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ])
}

function parseEnvelope(encoded: string): Envelope {
  let envelope: Envelope
  try {
    envelope = JSON.parse(encoded) as Envelope
  } catch {
    throw new Error('Stored portal credential envelope is malformed.')
  }
  if (envelope.v !== 1 && envelope.v !== 2) {
    throw new Error('Unsupported portal credential envelope version.')
  }
  return envelope
}

/**
 * Data keys are cached for the life of the process. They are already in memory
 * whenever a credential is in use, so caching them costs no additional
 * exposure and saves a query per encrypt and decrypt.
 */
const dekCache = new Map<string, Buffer>()

/** Returns the user's data key, creating and wrapping one on first use. */
async function dataKeyFor(userId: string): Promise<Buffer> {
  const cached = dekCache.get(userId)
  if (cached) return cached

  const [existing] = await db
    .select({ wrappedDek: userKeys.wrappedDek })
    .from(userKeys)
    .where(eq(userKeys.userId, userId))
    .limit(1)

  if (existing) {
    const dek = open(masterKey(), parseEnvelope(existing.wrappedDek))
    dekCache.set(userId, dek)
    return dek
  }

  const dek = crypto.randomBytes(32)
  const wrappedDek = seal(masterKey(), dek, 1)

  // `onConflictDoUpdate` would overwrite a key another request just created
  // and orphan everything encrypted under it. Do nothing, then read back
  // whichever key won the race.
  await db.insert(userKeys).values({ userId, wrappedDek }).onConflictDoNothing()

  const [stored] = await db
    .select({ wrappedDek: userKeys.wrappedDek })
    .from(userKeys)
    .where(eq(userKeys.userId, userId))
    .limit(1)
  if (!stored) throw new Error('Could not store a data key for this user.')

  const winning = open(masterKey(), parseEnvelope(stored.wrappedDek))
  dekCache.set(userId, winning)
  return winning
}

export async function encryptCredential<T>(userId: string, value: T): Promise<string> {
  const dek = await dataKeyFor(userId)
  return seal(dek, Buffer.from(JSON.stringify(value), 'utf8'), 2)
}

export async function decryptCredential<T>(userId: string, encoded: string): Promise<T> {
  const envelope = parseEnvelope(encoded)
  // A v1 value predates per-user keys and is sealed under the master key.
  const key = envelope.v === 1 ? masterKey() : await dataKeyFor(userId)
  return JSON.parse(open(key, envelope).toString('utf8')) as T
}

/** Drops cached data keys. Call after rotating the master key. */
export function clearDataKeyCache(): void {
  dekCache.clear()
}

export function generatePortalPassword(): string {
  return `${crypto.randomBytes(18).toString('base64url')}Aa1!`
}
