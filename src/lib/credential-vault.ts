import crypto from 'node:crypto'
import { env } from '../config/env.js'
import { serviceUnavailable } from './errors.js'

interface Envelope {
  v: 1
  iv: string
  tag: string
  ciphertext: string
}

function key(): Buffer {
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

export function encryptCredential<T>(value: T): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ])
  const envelope: Envelope = {
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
  return JSON.stringify(envelope)
}

export function decryptCredential<T>(encoded: string): T {
  let envelope: Envelope
  try {
    envelope = JSON.parse(encoded) as Envelope
  } catch {
    throw new Error('Stored portal credential envelope is malformed.')
  }
  if (envelope.v !== 1) throw new Error('Unsupported portal credential envelope version.')

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(envelope.iv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ])
  return JSON.parse(plain.toString('utf8')) as T
}

export function generatePortalPassword(): string {
  return `${crypto.randomBytes(18).toString('base64url')}Aa1!`
}
