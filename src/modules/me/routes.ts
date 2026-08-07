import { eq } from 'drizzle-orm'
import { Router } from 'express'
import { db } from '../../db/client.js'
import { kits, users, type Kit } from '../../db/schema.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { asyncHandler, created, noContent, ok, pathParam } from '../../lib/http.js'
import { buildObjectKey, createSignedUrl, removeObject, uploadObject } from '../../lib/storage.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { photoUpload } from '../../middleware/upload.js'
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

async function serializeKitResponse(kit: Kit | undefined) {
  const data = serializeKit(kit)
  if (!kit?.photoStoragePath) return data
  return { ...data, photoUrl: await createSignedUrl(kit.photoStoragePath) }
}

function validPhotoSignature(file: Express.Multer.File): boolean {
  const bytes = file.buffer
  if (file.mimetype === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
  if (file.mimetype === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (file.mimetype === 'image/webp') {
    return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  return false
}

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
      ...(await serializeKitResponse(kit)),
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
    ok(res, { ...(await serializeKitResponse(kit)), employments: history.map(serializeEmployment) })
  }),
)

meRouter.post(
  '/kit/photo',
  photoUpload.single('photo'),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const file = req.file
    if (!file) throw badRequest('Attach the profile photo as a `photo` field.')
    if (!validPhotoSignature(file)) throw badRequest('Profile photo bytes do not match its file type.')

    const [existing] = await db.select().from(kits).where(eq(kits.userId, auth.id)).limit(1)
    if (!existing) throw notFound('Kit not found')

    const key = buildObjectKey(auth.id, 'profile-photo', file.originalname)
    await uploadObject({ key, body: file.buffer, mimeType: file.mimetype })

    let updated: Kit | undefined
    try {
      ;[updated] = await db
        .update(kits)
        .set({
          photoStoragePath: key,
          photoFileName: file.originalname,
          photoMimeType: file.mimetype,
          updatedAt: new Date(),
        })
        .where(eq(kits.userId, auth.id))
        .returning()
    } catch (error) {
      await removeObject(key)
      throw error
    }

    if (!updated) throw notFound('Kit not found')
    if (existing.photoStoragePath) await removeObject(existing.photoStoragePath)
    const history = await getEmployments(auth.id)
    ok(res, { ...(await serializeKitResponse(updated)), employments: history.map(serializeEmployment) })
  }),
)

meRouter.delete(
  '/kit/photo',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [existing] = await db.select().from(kits).where(eq(kits.userId, auth.id)).limit(1)
    if (!existing) throw notFound('Kit not found')
    await db
      .update(kits)
      .set({
        photoStoragePath: null,
        photoFileName: null,
        photoMimeType: null,
        updatedAt: new Date(),
      })
      .where(eq(kits.userId, auth.id))
    if (existing.photoStoragePath) await removeObject(existing.photoStoragePath)
    noContent(res)
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
