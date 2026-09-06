import crypto from 'node:crypto'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { huntSpecs, kits, refreshTokens, users, type User } from '../../db/schema.js'
import { badRequest, conflict, serviceUnavailable, unauthorized } from '../../lib/errors.js'
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
import { env, hasGoogleAuth } from '../../config/env.js'
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

/* ------------------------------------------------------------ Google login */

/** Short-lived, single-use login states. The state never contains user data. */
const pendingGoogleStates = new Map<string, { at: number }>()

function sweepGoogleStates(): void {
  const cutoff = Date.now() - 10 * 60_000
  for (const [state, entry] of pendingGoogleStates) {
    if (entry.at < cutoff) pendingGoogleStates.delete(state)
  }
}

export function startGoogleSignIn(): string {
  if (!hasGoogleAuth || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_AUTH_REDIRECT) {
    throw serviceUnavailable(
      'Google login is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_AUTH_REDIRECT.',
    )
  }

  sweepGoogleStates()
  const state = crypto.randomBytes(24).toString('base64url')
  pendingGoogleStates.set(state, { at: Date.now() })

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', env.GOOGLE_AUTH_REDIRECT)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

interface GoogleTokens {
  access_token?: string
  id_token?: string
}

interface GoogleProfile {
  sub?: string
  email?: string
  email_verified?: boolean
  name?: string
}

async function googleJson<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  } catch {
    throw serviceUnavailable('Google is not reachable right now. Try again in a moment.')
  }

  const raw = await response.text()
  if (!response.ok) {
    throw badRequest('Google could not complete sign-in. Try again.')
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    throw badRequest('Google returned an invalid sign-in response.')
  }
}

export async function completeGoogleSignIn(
  code: string,
  state: string,
  context: RequestContext,
): Promise<AuthSession> {
  const pending = pendingGoogleStates.get(state)
  pendingGoogleStates.delete(state)
  if (!pending || pending.at < Date.now() - 10 * 60_000) {
    throw badRequest('That Google sign-in link has expired. Start again.')
  }
  if (!hasGoogleAuth || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_AUTH_REDIRECT) {
    throw serviceUnavailable('Google login is not configured.')
  }

  const tokens = await googleJson<GoogleTokens>('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_AUTH_REDIRECT,
      grant_type: 'authorization_code',
      code,
    }).toString(),
  })
  if (!tokens.access_token) throw badRequest('Google did not return an access token.')

  // The userinfo response is bound to the exchanged access token. When Google
  // returns an ID token as well, tokeninfo gives us an explicit audience check
  // without bringing a second JWT library into the API.
  if (tokens.id_token) {
    const tokenInfo = await googleJson<{ aud?: string; iss?: string }>(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`,
      { method: 'GET' },
    )
    if (tokenInfo.aud !== env.GOOGLE_CLIENT_ID || (tokenInfo.iss && !['accounts.google.com', 'https://accounts.google.com'].includes(tokenInfo.iss))) {
      throw badRequest('Google returned an invalid identity token.')
    }
  }

  const profile = await googleJson<GoogleProfile>('https://openidconnect.googleapis.com/v1/userinfo', {
    method: 'GET',
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })
  const email = profile.email?.trim().toLowerCase()
  if (!profile.sub || !email || profile.email_verified !== true) {
    throw badRequest('Google did not provide a verified email address.')
  }

  const [byGoogleSubject] = await db
    .select()
    .from(users)
    .where(eq(users.googleSubject, profile.sub))
    .limit(1)
  const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (byGoogleSubject && byEmail && byGoogleSubject.id !== byEmail.id) {
    throw conflict('That Google account is already linked to another Huntly account.')
  }

  let user = byGoogleSubject ?? byEmail
  let created = false
  if (!user) {
    const passwordHash = await hashPassword(crypto.randomBytes(32).toString('base64url'))
    user = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          email,
          googleSubject: profile.sub,
          passwordHash,
          name: profile.name?.trim() || email.split('@')[0] || 'Huntly user',
          avatar: avatarFor(email),
          onboarded: false,
        })
        .returning()
      if (!row) throw new Error('Insert returned no user')
      await tx.insert(kits).values({ userId: row.id, fullName: row.name, email: row.email })
      await tx.insert(huntSpecs).values({ userId: row.id })
      return row
    })
    created = true
  } else {
    // Custom matching: a pre-existing password account with the same verified
    // email is linked in place, preserving its kit, onboarding and avatar.
    if (!user.googleSubject) {
      const [linked] = await db
        .update(users)
        .set({ googleSubject: profile.sub, updatedAt: new Date() })
        .where(eq(users.id, user.id))
        .returning()
      if (linked) user = linked
    }
  }

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))
  if (created) {
    await recordActivity({
      userId: user.id,
      kind: 'account_created',
      text: 'Welcome to Job Hunters — your den is ready.',
    })
  }
  logger.info({ userId: user.id, created }, 'signed in with Google')
  return issueSession(user, context)
}

async function issueSession(user: User, context: RequestContext): Promise<AuthSession> {
  // The id is generated here rather than by the database, which breaks the
  // chicken-and-egg the previous version worked around with an insert followed
  // by an update: the token needs the row id, and the row needs the token's
  // hash. Deciding the id up front makes it a single insert, and the row is
  // never briefly stored with a placeholder hash.
  const tokenId = crypto.randomUUID()
  const refreshToken = signRefreshToken({ userId: user.id, tokenId })

  const [insert, dto] = await Promise.all([
    db.insert(refreshTokens).values({
      id: tokenId,
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: expiryFromDuration(env.JWT_REFRESH_TTL),
      userAgent: context.userAgent ?? null,
      ipAddress: context.ipAddress ?? null,
    }),
    serializeUserWithKit(user),
  ])
  void insert

  return {
    user: dto,
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

  // The login stamp is bookkeeping; the caller should not wait a round trip
  // for it. It still runs inside this request, just alongside the session.
  const [session] = await Promise.all([
    issueSession(user, context),
    db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id)),
  ])

  logger.info({ userId: user.id }, 'signed in')
  return session
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
