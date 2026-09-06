import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/client.js'
import {
  outreachMessages,
  outreachProspects,
  outreachTargets,
  userSchedules,
} from '../../db/schema.js'
import { notFound } from '../../lib/errors.js'
import { asyncHandler, created, ok, pathParam } from '../../lib/http.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { DEFAULT_LIMITS, NEVER_AUTOMATED } from '../../outreach/limits.js'
import { acceptanceRate, loadHealth, nextSendable, sentCounts } from '../../outreach/sequence.js'

export const outreachRouter: Router = Router()
outreachRouter.use(requireAuth)

const targetSchema = z.object({
  company: z.string().trim().min(1).max(160),
  targetRole: z.string().trim().max(160).optional(),
  jobId: z.string().uuid().optional(),
})

const idParam = z.object({ id: z.string().uuid() })
const approveSchema = z.object({ messageIds: z.array(z.string().uuid()).min(1).max(50) })

/** "Get me referred at X." */
outreachRouter.post(
  '/targets',
  validate({ body: targetSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const body = req.body as z.infer<typeof targetSchema>

    const [row] = await db
      .insert(outreachTargets)
      .values({
        userId: auth.id,
        company: body.company,
        targetRole: body.targetRole ?? null,
        jobId: body.jobId ?? null,
      })
      .returning()
    if (!row) throw new Error('Could not create an outreach target')

    created(res, {
      id: row.id,
      company: row.company,
      targetRole: row.targetRole,
      // Finding people needs a LinkedIn session and runs on the runner, so the
      // honest answer here is "queued", not "done".
      prospects: [],
      note: 'Hunty will look for people who could refer you at your next LinkedIn sweep.',
    })
  }),
)

outreachRouter.get(
  '/targets',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const targets = await db
      .select()
      .from(outreachTargets)
      .where(eq(outreachTargets.userId, auth.id))
      .orderBy(desc(outreachTargets.createdAt))

    const counts = await db
      .select({ targetId: outreachProspects.targetId, state: outreachProspects.state })
      .from(outreachProspects)
      .where(eq(outreachProspects.userId, auth.id))

    ok(
      res,
      targets.map((target) => ({
        id: target.id,
        company: target.company,
        targetRole: target.targetRole,
        status: target.status,
        createdAt: target.createdAt.toISOString(),
        prospects: counts.filter((row) => row.targetId === target.id).length,
        waiting: counts.filter((row) => row.targetId === target.id && row.state === 'drafted').length,
      })),
    )
  }),
)

/** Ranked people for one company, with the drafts awaiting approval. */
outreachRouter.get(
  '/targets/:id/prospects',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const targetId = pathParam(req, 'id')

    const [target] = await db
      .select()
      .from(outreachTargets)
      .where(and(eq(outreachTargets.id, targetId), eq(outreachTargets.userId, auth.id)))
      .limit(1)
    if (!target) throw notFound('Outreach target not found')

    const prospects = await db
      .select()
      .from(outreachProspects)
      .where(eq(outreachProspects.targetId, targetId))
      .orderBy(desc(outreachProspects.score))

    const messages =
      prospects.length === 0
        ? []
        : await db
            .select()
            .from(outreachMessages)
            .where(
              inArray(
                outreachMessages.prospectId,
                prospects.map((prospect) => prospect.id),
              ),
            )

    ok(res, {
      company: target.company,
      targetRole: target.targetRole,
      prospects: prospects.map((prospect) => ({
        id: prospect.id,
        name: prospect.name,
        title: prospect.title,
        profileUrl: prospect.profileUrl,
        degree: prospect.degree,
        score: prospect.score,
        signals: prospect.signals,
        state: prospect.state,
        invitedAt: prospect.invitedAt?.toISOString() ?? null,
        acceptedAt: prospect.acceptedAt?.toISOString() ?? null,
        messages: messages
          .filter((message) => message.prospectId === prospect.id)
          .map((message) => ({
            id: message.id,
            kind: message.kind,
            body: message.body,
            approved: message.approvedAt !== null,
            sentAt: message.sentAt?.toISOString() ?? null,
          })),
      })),
    })
  }),
)

/**
 * The only path to a sent message.
 *
 * Approval is per message rather than per person: the invitation and the
 * follow-up ask are different things to put your name to, and someone may
 * well want to edit the second after seeing how the first landed.
 */
outreachRouter.post(
  '/messages/approve',
  validate({ body: approveSchema }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const body = req.body as z.infer<typeof approveSchema>

    const updated = await db
      .update(outreachMessages)
      .set({ approvedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(outreachMessages.userId, auth.id),
          inArray(outreachMessages.id, body.messageIds),
          isNull(outreachMessages.approvedAt),
        ),
      )
      .returning({ id: outreachMessages.id, prospectId: outreachMessages.prospectId })

    if (updated.length > 0) {
      await db
        .update(outreachProspects)
        .set({ state: 'approved', updatedAt: new Date() })
        .where(
          and(
            eq(outreachProspects.userId, auth.id),
            inArray(
              outreachProspects.id,
              updated.map((row) => row.prospectId),
            ),
            eq(outreachProspects.state, 'drafted'),
          ),
        )
    }

    ok(res, { approved: updated.length })
  }),
)

/** Editing a draft un-approves it — the words that were approved are the words that send. */
outreachRouter.put(
  '/messages/:id',
  validate({ params: idParam, body: z.object({ body: z.string().trim().min(1).max(2000) }) }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [row] = await db
      .update(outreachMessages)
      .set({ body: req.body.body, approvedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(outreachMessages.id, pathParam(req, 'id')),
          eq(outreachMessages.userId, auth.id),
          isNull(outreachMessages.sentAt),
        ),
      )
      .returning()
    if (!row) throw notFound('Message not found, or it has already been sent.')
    ok(res, { id: row.id, body: row.body, approved: false })
  }),
)

/**
 * The account-health strip.
 *
 * If this engine is ever quietly damaging the user's LinkedIn account, this is
 * where they see it first — which is why it is a first-class screen and not a
 * debug endpoint.
 */
outreachRouter.get(
  '/health',
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    const [health, rate, counts, schedule] = await Promise.all([
      loadHealth(auth.id),
      acceptanceRate(auth.id),
      sentCounts(auth.id),
      db
        .select({ enabled: userSchedules.outreachEnabled, timezone: userSchedules.timezone })
        .from(userSchedules)
        .where(eq(userSchedules.userId, auth.id))
        .limit(1),
    ])
    const sendable = await nextSendable(auth.id, {
      health,
      counts,
      schedule: schedule[0],
    })

    const paused = health.pausedUntil !== null && health.pausedUntil.getTime() > Date.now()

    ok(res, {
      enabled: schedule[0]?.enabled ?? false,
      timezone: schedule[0]?.timezone ?? null,
      invitesToday: health.invitesToday,
      invitesThisWeek: health.invites7d,
      challenges30d: health.challenges30d,
      acceptance: rate,
      paused,
      pausedUntil: health.pausedUntil?.toISOString() ?? null,
      status: 'blocked' in sendable ? sendable.blocked : 'Ready to send.',
      limits: {
        invitesPerDay: DEFAULT_LIMITS.invitesPerDay,
        invitesPerWeek: DEFAULT_LIMITS.invitesPerWeek,
        perCompanyPerDay: DEFAULT_LIMITS.perCompanyPerDay,
        sendWindow: DEFAULT_LIMITS.sendWindow,
        withdrawAfterDays: DEFAULT_LIMITS.withdrawAfterDays,
      },
      neverAutomated: NEVER_AUTOMATED,
    })
  }),
)

/** Explicit opt-in. Off until the user turns it on, and reversible here. */
outreachRouter.put(
  '/settings',
  validate({ body: z.object({ enabled: z.boolean() }) }),
  asyncHandler(async (req, res) => {
    const auth = currentUser(req)
    await db
      .insert(userSchedules)
      .values({ userId: auth.id, outreachEnabled: req.body.enabled })
      .onConflictDoUpdate({
        target: userSchedules.userId,
        set: { outreachEnabled: req.body.enabled, updatedAt: new Date() },
      })
    ok(res, { enabled: req.body.enabled })
  }),
)
