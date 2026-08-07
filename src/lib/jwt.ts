import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { unauthorized } from './errors.js'

/**
 * Two-token scheme.
 *
 * Access token: short-lived, signed, stateless, sent as `Authorization: Bearer`.
 * Refresh token: long-lived, opaque-ish, and — crucially — its SHA-256 is a row
 * in `refresh_tokens`. Signature alone is not enough to refresh; the row must
 * exist, be unexpired and unrevoked. That is what makes logout actually log
 * out, and what lets us kill a session server-side.
 */

export type TokenType = 'access' | 'refresh'

export interface AccessTokenPayload {
  sub: string
  email: string
  type: 'access'
}

export interface RefreshTokenPayload {
  sub: string
  /** Ties the JWT to its `refresh_tokens` row. */
  jti: string
  type: 'refresh'
}

export function signAccessToken(payload: { userId: string; email: string }): string {
  return jwt.sign({ email: payload.email, type: 'access' }, env.JWT_ACCESS_SECRET, {
    subject: payload.userId,
    issuer: env.JWT_ISSUER,
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  })
}

export function signRefreshToken(payload: { userId: string; tokenId: string }): string {
  return jwt.sign({ type: 'refresh' }, env.JWT_REFRESH_SECRET, {
    subject: payload.userId,
    jwtid: payload.tokenId,
    issuer: env.JWT_ISSUER,
    expiresIn: env.JWT_REFRESH_TTL as jwt.SignOptions['expiresIn'],
  })
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: env.JWT_ISSUER,
    }) as jwt.JwtPayload

    if (decoded.type !== 'access' || typeof decoded.sub !== 'string') {
      throw unauthorized('Malformed access token')
    }
    return { sub: decoded.sub, email: String(decoded.email ?? ''), type: 'access' }
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw unauthorized('Access token expired', { reason: 'token_expired' })
    }
    throw unauthorized('Invalid access token')
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, {
      issuer: env.JWT_ISSUER,
    }) as jwt.JwtPayload

    if (decoded.type !== 'refresh' || typeof decoded.sub !== 'string' || !decoded.jti) {
      throw unauthorized('Malformed refresh token')
    }
    return { sub: decoded.sub, jti: decoded.jti, type: 'refresh' }
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw unauthorized('Refresh token expired', { reason: 'token_expired' })
    }
    throw unauthorized('Invalid refresh token')
  }
}

/** What actually lands in the `refresh_tokens.token_hash` column. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** Turn "30d" / "15m" / "3600" into an absolute expiry. */
export function expiryFromDuration(duration: string, from = new Date()): Date {
  const match = /^(\d+)\s*(ms|s|m|h|d|w|y)?$/i.exec(duration.trim())
  if (!match) throw new Error(`Cannot parse duration: ${duration}`)

  const amount = Number(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    y: 31_536_000_000,
  }
  return new Date(from.getTime() + amount * (multipliers[unit] ?? 1000))
}

export function accessTokenExpiresInSeconds(): number {
  return Math.round((expiryFromDuration(env.JWT_ACCESS_TTL).getTime() - Date.now()) / 1000)
}
