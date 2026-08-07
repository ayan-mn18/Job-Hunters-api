import { Router } from 'express'
import { asyncHandler, created, noContent, ok } from '../../lib/http.js'
import { currentUser, optionalAuth, requireAuth } from '../../middleware/auth.js'
import { authLimiter, refreshLimiter } from '../../middleware/rateLimit.js'
import { validate } from '../../middleware/validate.js'
import { serializeUserWithKit } from '../../serializers/user.js'
import { db } from '../../db/client.js'
import { users } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { unauthorized } from '../../lib/errors.js'
import {
  changePasswordSchema,
  logoutSchema,
  refreshSchema,
  signInSchema,
  signUpSchema,
} from './schemas.js'
import {
  changePassword,
  refreshSession,
  revokeAllForUser,
  revokeRefreshToken,
  signIn,
  signUp,
} from './service.js'

export const authRouter: Router = Router()

/**
 * Tokens are returned in the JSON body rather than set as httpOnly cookies.
 *
 * That is a real trade-off and worth naming: cookies would be safer against
 * XSS. But the UI is a separate-origin Vite SPA that already models auth as an
 * in-memory value, cross-site cookies need SameSite=None plus HTTPS plus a
 * CSRF story, and the same tokens have to work from a future mobile client.
 * Body-returned bearer tokens is the shape that fits. Revisit if the SPA ever
 * moves behind the same origin.
 */

authRouter.post(
  '/signup',
  authLimiter,
  validate({ body: signUpSchema }),
  asyncHandler(async (req, res) => {
    const session = await signUp(req.body, {
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    })
    created(res, session)
  }),
)

authRouter.post(
  '/login',
  authLimiter,
  validate({ body: signInSchema }),
  asyncHandler(async (req, res) => {
    const session = await signIn(req.body, {
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    })
    ok(res, session)
  }),
)

authRouter.post(
  '/refresh',
  refreshLimiter,
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const session = await refreshSession(req.body.refreshToken, {
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    })
    ok(res, session)
  }),
)

/**
 * Logout does not require a valid access token. If the access token has
 * already expired the user still wants out, and refusing would leave a live
 * refresh token behind.
 */
authRouter.post(
  '/logout',
  optionalAuth,
  validate({ body: logoutSchema }),
  asyncHandler(async (req, res) => {
    const { refreshToken, allDevices } = req.body

    if (allDevices) {
      if (!req.user) throw unauthorized('Signing out everywhere needs a valid access token.')
      await revokeAllForUser(req.user.id)
    } else if (refreshToken) {
      await revokeRefreshToken(refreshToken)
    }
    noContent(res)
  }),
)

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [row] = await db.select().from(users).where(eq(users.id, auth.id)).limit(1)
    if (!row) throw unauthorized('Account no longer exists.')
    ok(res, await serializeUserWithKit(row))
  }),
)

authRouter.post(
  '/change-password',
  requireAuth,
  authLimiter,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    await changePassword(auth.id, req.body.currentPassword, req.body.newPassword)
    noContent(res)
  }),
)
