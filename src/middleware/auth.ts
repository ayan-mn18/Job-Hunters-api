import { eq } from 'drizzle-orm'
import type { NextFunction, Request, Response } from 'express'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import { unauthorized } from '../lib/errors.js'
import { verifyAccessToken } from '../lib/jwt.js'

export interface AuthenticatedUser {
  id: string
  email: string
  name: string
  avatar: string
  onboarded: boolean
  joinedAt: Date
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser
      requestId?: string
    }
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null
  return token.trim() || null
}

/**
 * Verifies the access token AND re-reads the user row. The extra query is
 * deliberate: it means a deleted account cannot keep using a token that has
 * not expired yet, and it keeps `req.user.onboarded` truthful for the
 * onboarding guard rather than frozen at whatever it was when the token was
 * minted.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractBearer(req)
    if (!token) throw unauthorized('Missing bearer token')

    const payload = verifyAccessToken(token)

    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatar: users.avatar,
        onboarded: users.onboarded,
        joinedAt: users.joinedAt,
      })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)

    if (!row) throw unauthorized('Account no longer exists')

    req.user = row
    next()
  } catch (error) {
    next(error)
  }
}

/** Same as above but never rejects — for routes that vary by signed-in state. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractBearer(req)
  if (!token) return next()
  try {
    const payload = verifyAccessToken(token)
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatar: users.avatar,
        onboarded: users.onboarded,
        joinedAt: users.joinedAt,
      })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)
    if (row) req.user = row
  } catch {
    // An invalid token on an optional route is simply "not signed in".
  }
  next()
}

/**
 * Narrowing helper so handlers do not have to re-check `req.user`. Typed
 * structurally so it accepts a request with narrowed generics.
 */
export function currentUser(req: { user?: AuthenticatedUser }): AuthenticatedUser {
  if (!req.user) throw unauthorized('Not authenticated')
  return req.user
}
