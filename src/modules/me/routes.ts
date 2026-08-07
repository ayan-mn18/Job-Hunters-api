import { eq } from 'drizzle-orm'
import { Router } from 'express'
import { db } from '../../db/client.js'
import { users } from '../../db/schema.js'
import { notFound } from '../../lib/errors.js'
import { asyncHandler, created, noContent, ok, pathParam } from '../../lib/http.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import {
  serializeEmployment,
  serializeKit,
  serializeUserWithKit,
} from '../../serializers/user.js'
import {
  completeOnboardingSchema,
  employmentSchema,
  employmentUpdateSchema,
  idParamSchema,
  updateKitSchema,
  updateProfileSchema,
} from './schemas.js'
import {
  completeOnboarding,
  createEmployment,
  deleteEmployment,
  getEmployments,
  getKit,
  getOnboardingSubmissions,
  updateEmployment,
  updateKit,
  updateProfile,
} from './service.js'

export const meRouter: Router = Router()

meRouter.use(requireAuth)

/**
 * `GET /me` is what the UI's AuthProvider calls on boot to restore a session,
 * so its shape has to match the `User` type in `src/auth/context.ts` exactly —
 * including the flattened `kit` projection.
 */
meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [row] = await db.select().from(users).where(eq(users.id, auth.id)).limit(1)
    if (!row) throw notFound('User not found')
    ok(res, await serializeUserWithKit(row))
  }),
)

meRouter.patch(
  '/',
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const row = await updateProfile(auth.id, req.body)
    ok(res, await serializeUserWithKit(row))
  }),
)

/* ---------------------------------------------------------------- the kit */

/** The full Kit screen: personal details, links, the awkward questions. */
meRouter.get(
  '/kit',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [kit, history] = await Promise.all([getKit(auth.id), getEmployments(auth.id)])
    ok(res, {
      ...serializeKit(kit),
      employments: history.map(serializeEmployment),
    })
  }),
)

/**
 * PUT rather than PATCH by name, but partial by behaviour: the UI saves the
 * whole form at once, and omitted keys are left alone rather than nulled.
 * Sending `null` explicitly is how a field gets cleared.
 */
meRouter.put(
  '/kit',
  validate({ body: updateKitSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const kit = await updateKit(auth.id, req.body)
    const history = await getEmployments(auth.id)
    ok(res, { ...serializeKit(kit), employments: history.map(serializeEmployment) })
  }),
)

/* --------------------------------------------------------- employment rows */

meRouter.get(
  '/kit/employments',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const rows = await getEmployments(auth.id)
    ok(res, rows.map(serializeEmployment))
  }),
)

meRouter.post(
  '/kit/employments',
  validate({ body: employmentSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    created(res, serializeEmployment(await createEmployment(auth.id, req.body)))
  }),
)

meRouter.patch(
  '/kit/employments/:id',
  validate({ params: idParamSchema, body: employmentUpdateSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const row = await updateEmployment(auth.id, pathParam(req, 'id'), req.body)
    ok(res, serializeEmployment(row))
  }),
)

meRouter.delete(
  '/kit/employments/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    await deleteEmployment(auth.id, pathParam(req, 'id'))
    noContent(res)
  }),
)

/* -------------------------------------------------------------- onboarding */

/**
 * Replaces `completeOnboarding` in the demo AuthContext. Returns the whole
 * user so the client can swap its state in one assignment, exactly as the
 * demo's `setUser` did.
 */
meRouter.post(
  '/onboarding',
  validate({ body: completeOnboardingSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const result = await completeOnboarding(auth.id, req.body)
    ok(
      res,
      await serializeUserWithKit(result.user),
      // Surfaced rather than swallowed: a portal id the UI knows about but the
      // catalogue does not is a bug worth seeing.
      result.unknownPortals.length > 0 ? { unknownPortals: result.unknownPortals } : undefined,
    )
  }),
)

/** The raw wizard answers, kept for audit. Not used by any screen. */
meRouter.get(
  '/onboarding/submissions',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    ok(res, await getOnboardingSubmissions(auth.id))
  }),
)
