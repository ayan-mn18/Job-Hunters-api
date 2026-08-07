import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { huntSpecs, kits, refreshTokens, users, type User } from '../../db/schema.js'
import { conflict, unauthorized } from '../../lib/errors.js'
import {
  accessTokenExpiresInSeconds,
  expiryFromDuration,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../lib/jwt.js'
import { logger } from '../../lib/logger.js'
import { fakeVerify, hashPassword, verifyPassword } from '../../lib/password.js'
import { env } from '../../config/env.js'
import { recordActivity } from '../../services/activity.js'
import { serializeUserWithKit, type UserDto } from '../../serializers/user.js'
import type { SignInInput, SignUpInput } from './schemas.js'

export interface AuthSession {
  user: UserDto
  accessToken: string
  refreshToken: string
  /** Seconds until the access token expires — the UI schedules refresh on it. */
  expiresIn: number
  tokenType: 'Bearer'
}

interface RequestContext {
  userAgent?: string | undefined
  ipAddress?: string | undefined
}

/** Same rule the demo UI used, so an existing account keeps its emoji. */
const AVATARS = ['🧑‍🚀', '🦝', '🐼', '🦊', '🐙', '🦉', '🐝', '🦄']

export function avatarFor(email: string): string {
  const sum = [...email].reduce((total, char) => total + char.charCodeAt(0), 0)
  return AVATARS[sum % AVATARS.length]!
}

async function issueSession(user: User, context: RequestContext): Promise<AuthSession> {
  const [tokenRow] = await db
    .insert(refreshTokens)
    .values({
      userId: user.id,
      // Placeholder: the real hash needs the token, and the token needs this
      // row's id. Written back immediately below, inside the same request.
      tokenHash: `pending:${crypto.randomUUID()}`,
      expiresAt: expiryFromDuration(env.JWT_REFRESH_TTL),
      userAgent: context.userAgent ?? null,
      ipAddress: context.ipAddress ?? null,
    })
    .returning({ id: refreshTokens.id })

  if (!tokenRow) throw new Error('Could not create a refresh token row')

  const refreshToken = signRefreshToken({ userId: user.id, tokenId: tokenRow.id })

  await db
    .update(refreshTokens)
    .set({ tokenHash: hashToken(refreshToken) })
    .where(eq(refreshTokens.id, tokenRow.id))

  return {
    user: await serializeUserWithKit(user),
    accessToken: signAccessToken({ userId: user.id, email: user.email }),
    refreshToken,
    expiresIn: accessTokenExpiresInSeconds(),
    tokenType: 'Bearer',
  }
}

export async function signUp(input: SignUpInput, context: RequestContext): Promise<AuthSession> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1)

  if (existing.length > 0) {
    throw conflict('An account with that email already exists.')
  }

  const passwordHash = await hashPassword(input.password)

  const user = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        email: input.email,
        passwordHash,
        name: input.name,
        avatar: avatarFor(input.email),
        onboarded: false,
      })
      .returning()

    if (!row) throw new Error('Insert returned no user')

    // Give every account its empty kit and default spec up front. Every later
    // read can then assume the row exists instead of handling "not yet".
    await tx.insert(kits).values({ userId: row.id, fullName: row.name, email: row.email })
    await tx.insert(huntSpecs).values({ userId: row.id })

    return row
  })

  await recordActivity({
    userId: user.id,
    kind: 'account_created',
    text: 'Welcome to Job Hunters — your den is ready.',
  })

  logger.info({ userId: user.id }, 'account created')
  return issueSession(user, context)
}

export async function signIn(input: SignInInput, context: RequestContext): Promise<AuthSession> {
  const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1)

  if (!user) {
    // Spend the bcrypt time anyway — otherwise the response time reveals
    // whether the address is registered.
    await fakeVerify(input.password)
    throw unauthorized('Email or password is wrong.')
  }

  const valid = await verifyPassword(input.password, user.passwordHash)
  if (!valid) throw unauthorized('Email or password is wrong.')

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))

  logger.info({ userId: user.id }, 'signed in')
  return issueSession(user, context)
}

/**
 * Refresh with rotation. The presented token is revoked and a new one issued,
 * so a stolen refresh token has a single use — and if the legitimate client
 * later presents the same revoked token, that is a detectable signal.
 */
export async function refreshSession(
  token: string,
  context: RequestContext,
): Promise<AuthSession> {
  const payload = verifyRefreshToken(token)
  const presentedHash = hashToken(token)

  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.id, payload.jti), eq(refreshTokens.userId, payload.sub)))
    .limit(1)

  if (!row) throw unauthorized('Refresh token is not recognised.')

  if (row.tokenHash !== presentedHash) {
    throw unauthorized('Refresh token does not match.')
  }

  if (row.revokedAt) {
    // Reuse of a rotated token: either replay of a stolen token or a badly
    // behaved client. Either way, drop every session for this account.
    logger.warn({ userId: row.userId, tokenId: row.id }, 'revoked refresh token replayed')
    await revokeAllForUser(row.userId)
    throw unauthorized('This session was already ended. Sign in again.')
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    throw unauthorized('Refresh token expired. Sign in again.')
  }

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1)
  if (!user) throw unauthorized('Account no longer exists.')

  const session = await issueSession(user, context)

  const newPayload = verifyRefreshToken(session.refreshToken)
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), replacedByTokenId: newPayload.jti })
    .where(eq(refreshTokens.id, row.id))

  return session
}

export async function revokeRefreshToken(token: string): Promise<void> {
  let tokenId: string
  try {
    tokenId = verifyRefreshToken(token).jti
  } catch {
    // An unparseable token on logout is not worth an error — the caller wanted
    // the session gone, and it is gone.
    return
  }
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, tokenId), isNull(refreshTokens.revokedAt)))
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) throw unauthorized('Account no longer exists.')

  const valid = await verifyPassword(currentPassword, user.passwordHash)
  if (!valid) throw unauthorized('Current password is wrong.')

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, userId))

  // A password change ends every other session. That is the whole point of
  // changing it.
  await revokeAllForUser(userId)
}

/**
 * Housekeeping: drop tokens that expired or were revoked over a month ago.
 * Nothing calls this on a timer yet — wire it into the scheduler workstream.
 */
export async function pruneRefreshTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000)
  const deleted = await db
    .delete(refreshTokens)
    .where(or(lt(refreshTokens.expiresAt, new Date()), lt(refreshTokens.revokedAt, cutoff)))
    .returning({ id: refreshTokens.id })
  return deleted.length
}
