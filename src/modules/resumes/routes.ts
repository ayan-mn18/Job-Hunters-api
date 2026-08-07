import { and, desc, eq } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import { resumes, type Resume } from '../../db/schema.js'
import { badRequest, conflict, notFound } from '../../lib/errors.js'
import { asyncHandler, created, noContent, ok, pathParam } from '../../lib/http.js'
import { logger } from '../../lib/logger.js'
import {
  buildObjectKey,
  createSignedUrl,
  downloadObject,
  removeObject,
  storageConfigured,
  uploadObject,
} from '../../lib/storage.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { resumeUpload } from '../../middleware/upload.js'
import { validate } from '../../middleware/validate.js'
import { recordActivity } from '../../services/activity.js'
import { serializeEmployment, serializeKit } from '../../serializers/user.js'
import { applyResumeAutofill } from '../me/service.js'
import { getResumeParser, readParsedResume } from '../../services/resume-parser.js'
import { buildResumeDocument, resumeDocumentSchema } from '../../hunt/resume-document.js'

export const resumesRouter: Router = Router()
resumesRouter.use(requireAuth)

const idParamSchema = z.object({ id: z.string().uuid() })

const listQuerySchema = z.object({
  kind: z.enum(['base', 'variant', 'all']).default('all'),
})

const documentUpdateSchema = z.object({
  document: resumeDocumentSchema,
  confirm: z.boolean().default(false),
})

interface ResumeDto {
  id: string
  fileName: string
  kind: string
  mimeType: string
  sizeBytes: number
  isBase: boolean
  parseStatus: string
  parsedAt: string | null
  parsedSkills: string[]
  parsedTitles: string[]
  parsedYearsExperience: number | null
  parseError: string | null
  autofillAvailable: boolean
  uploadedAt: string
  structuredVersion: number
  structuredConfirmedAt: string | null
}

function serializeResume(row: Resume): ResumeDto {
  return {
    id: row.id,
    fileName: row.fileName,
    kind: row.kind,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    isBase: row.isBase,
    parseStatus: row.parseStatus,
    parsedAt: row.parsedAt?.toISOString() ?? null,
    parsedSkills: row.parsedSkills,
    parsedTitles: row.parsedTitles,
    parsedYearsExperience: row.parsedYearsExperience,
    parseError: row.parseError,
    autofillAvailable:
      row.isBase && (row.parseStatus !== 'failed' || readParsedResume(row.parsedProfile) !== null),
    uploadedAt: row.createdAt.toISOString(),
    structuredVersion: row.structuredVersion,
    structuredConfirmedAt: row.structuredConfirmedAt?.toISOString() ?? null,
  }
}
async function parseAndStoreResume(row: Resume, buffer: Buffer): Promise<Resume> {
  const parser = getResumeParser()
  try {
    const parsed = await parser.parse({
      resumeId: row.id,
      userId: row.userId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      storagePath: row.storagePath,
      buffer,
    })
    const [updated] = await db
      .update(resumes)
      .set({
        parseStatus: 'parsed',
        parsedAt: new Date(),
        parseError: null,
        parsedProfile: parsed,
        parsedSkills: parsed.skills,
        parsedTitles: parsed.titles,
        parsedYearsExperience: parsed.yearsExperience,
        structuredDocument: buildResumeDocument(parsed),
        structuredVersion: 1,
        structuredConfirmedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(resumes.id, row.id))
      .returning()
    return updated ?? row
  } catch (error) {
    logger.error({ err: error, resumeId: row.id }, 'resume parse failed')
    const [updated] = await db
      .update(resumes)
      .set({
        parseStatus: 'failed',
        parseError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(resumes.id, row.id))
      .returning()
    return updated ?? row
  }
}

resumesRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const kind = (req.query.kind as string | undefined) ?? 'all'

    const where =
      kind === 'all'
        ? eq(resumes.userId, auth.id)
        : and(eq(resumes.userId, auth.id), eq(resumes.kind, kind as 'base' | 'variant'))

    const rows = await db.select().from(resumes).where(where).orderBy(desc(resumes.createdAt))
    ok(res, rows.map(serializeResume))
  }),
)

/** The one the Hunt screen shows under "Base resume". */
resumesRouter.get(
  '/base',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [row] = await db
      .select()
      .from(resumes)
      .where(and(eq(resumes.userId, auth.id), eq(resumes.isBase, true)))
      .limit(1)

    ok(res, row ? serializeResume(row) : null)
  }),
)

/** Upload, store, parse once, then keep structured fields for later autofill. */
resumesRouter.post(
  '/',
  resumeUpload.single('file'),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const file = req.file

    if (!file) throw badRequest('Attach the resume as a `file` field.')
    if (!storageConfigured()) {
      throw badRequest(
        'Supabase Storage is not configured, so the file cannot be stored. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
      )
    }

    const makeBase = req.body?.isBase !== 'false'
    const key = buildObjectKey(auth.id, 'base', file.originalname)

    await uploadObject({ key, body: file.buffer, mimeType: file.mimetype })

    let row: Resume
    try {
      row = await db.transaction(async (tx) => {
        if (makeBase) {
          // The partial unique index allows exactly one base per user, so the
          // old one has to be demoted before the new one is inserted.
          await tx
            .update(resumes)
            .set({ isBase: false, updatedAt: new Date() })
            .where(and(eq(resumes.userId, auth.id), eq(resumes.isBase, true)))
        }

        const [inserted] = await tx
          .insert(resumes)
          .values({
            userId: auth.id,
            kind: 'base',
            fileName: file.originalname,
            storagePath: key,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            isBase: makeBase,
            parseStatus: 'pending',
          })
          .returning()

        if (!inserted) throw new Error('Resume insert returned no row')
        return inserted
      })
    } catch (error) {
      // Do not leave an orphan object in the bucket if the row failed.
      await removeObject(key)
      throw error
    }

    row = await parseAndStoreResume(row, file.buffer)

    await recordActivity({
      userId: auth.id,
      kind: 'resume_uploaded',
      text: `Read your resume — ${file.originalname}`,
      meta: { resumeId: row.id },
    })

    created(res, serializeResume(row))
  }),
)

/** Apply parsed values to blank Kit fields without overwriting user edits. */
resumesRouter.post(
  '/:id/autofill',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    let [row] = await db
      .select()
      .from(resumes)
      .where(and(eq(resumes.id, pathParam(req, 'id')), eq(resumes.userId, auth.id)))
      .limit(1)
    if (!row) throw notFound('Resume not found')
    let profile = readParsedResume(row.parsedProfile)
    if (!profile) {
      row = await parseAndStoreResume(row, await downloadObject(row.storagePath))
      profile = readParsedResume(row.parsedProfile)
    }
    if (!profile) {
      throw conflict(row.parseError || 'This resume could not be parsed. Upload a PDF or DOCX.')
    }

    const result = await applyResumeAutofill(auth.id, profile)
    ok(res, {
      resume: serializeResume(row),
      roles: result.roles,
      kit: {
        ...serializeKit(result.kit),
        employments: result.employments.map(serializeEmployment),
      },
      applied: result.applied,
    })
  }),
)

resumesRouter.get(
  '/:id/document',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [row] = await db
      .select()
      .from(resumes)
      .where(and(eq(resumes.id, pathParam(req, 'id')), eq(resumes.userId, auth.id)))
      .limit(1)
    if (!row) throw notFound('Resume not found')
    if (!row.structuredDocument) throw conflict('This resume has no structured document yet.')
    ok(res, {
      document: row.structuredDocument,
      version: row.structuredVersion,
      confirmedAt: row.structuredConfirmedAt?.toISOString() ?? null,
    })
  }),
)

resumesRouter.put(
  '/:id/document',
  validate({ params: idParamSchema, body: documentUpdateSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const body = req.body as z.infer<typeof documentUpdateSchema>
    const nextVersion = body.document.version + 1
    const nextDocument = { ...body.document, version: nextVersion }
    const [row] = await db
      .update(resumes)
      .set({
        structuredDocument: nextDocument,
        structuredVersion: nextVersion,
        structuredConfirmedAt: body.confirm ? new Date() : null,
        parsedSkills: nextDocument.skills.map((skill) => skill.name),
        parsedTitles: nextDocument.experience.map((experience) => experience.role),
        updatedAt: new Date(),
      })
      .where(and(eq(resumes.id, pathParam(req, 'id')), eq(resumes.userId, auth.id)))
      .returning()
    if (!row) throw notFound('Resume not found')
    ok(res, {
      document: row.structuredDocument,
      version: row.structuredVersion,
      confirmedAt: row.structuredConfirmedAt?.toISOString() ?? null,
    })
  }),
)

/** Short-lived signed URL. The bucket is private; there is no public link. */
resumesRouter.get(
  '/:id/download',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [row] = await db
      .select()
      .from(resumes)
      .where(and(eq(resumes.id, pathParam(req, 'id')), eq(resumes.userId, auth.id)))
      .limit(1)

    if (!row) throw notFound('Resume not found')
    ok(res, { url: await createSignedUrl(row.storagePath), fileName: row.fileName })
  }),
)

resumesRouter.post(
  '/:id/base',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)

    const row = await db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(resumes)
        .where(and(eq(resumes.id, pathParam(req, 'id')), eq(resumes.userId, auth.id)))
        .limit(1)

      if (!target) throw notFound('Resume not found')

      await tx
        .update(resumes)
        .set({ isBase: false, updatedAt: new Date() })
        .where(and(eq(resumes.userId, auth.id), eq(resumes.isBase, true)))

      const [updated] = await tx
        .update(resumes)
        .set({ isBase: true, updatedAt: new Date() })
        .where(eq(resumes.id, target.id))
        .returning()

      if (!updated) throw notFound('Resume not found')
      return updated
    })

    ok(res, serializeResume(row))
  }),
)

resumesRouter.delete(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [row] = await db
      .select()
      .from(resumes)
      .where(and(eq(resumes.id, pathParam(req, 'id')), eq(resumes.userId, auth.id)))
      .limit(1)

    if (!row) throw notFound('Resume not found')

    await db.delete(resumes).where(eq(resumes.id, row.id))
    await removeObject(row.storagePath)
    noContent(res)
  }),
)
