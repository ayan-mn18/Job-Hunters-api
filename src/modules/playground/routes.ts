import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler, created, ok } from '../../lib/http.js'
import { badRequest, conflict, serviceUnavailable } from '../../lib/errors.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { validate } from '../../middleware/validate.js'
import { hasRedis, env } from '../../config/env.js'
import { db } from '../../db/client.js'
import { playgroundRuns } from '../../db/schema.js'
import { getQueue } from '../../queues/index.js'
import { QUEUE, type PlaygroundJobData } from '../../queues/names.js'
import { postReply } from '../../playground/replies.js'
import { listMessages, listRuns, loadRun, say, setState } from '../../playground/store.js'

/**
 * The playground's HTTP surface.
 *
 * Deliberately thin. Starting a run queues a job and returns; everything after
 * that happens on the runner and reaches the browser over the live socket.
 * The three POSTs that follow are all the same act — a person answering the
 * run — and they all end up on the same Redis list, because the run is
 * blocking on exactly one thing at a time.
 */

export const playgroundRouter: Router = Router()
playgroundRouter.use(requireAuth)

const idSchema = z.object({ id: z.string().uuid() })
const startSchema = z.object({ prompt: z.string().trim().min(3).max(500) })
const textSchema = z.object({ text: z.string().trim().min(1).max(2_000) })
const approveSchema = z.object({ url: z.string().url().max(2_000).optional() })

/** Statuses a run can still be talked to in. */
const LIVE = new Set(['queued', 'launching', 'searching', 'shortlisted', 'applying', 'blocked'])

function runDto(run: typeof playgroundRuns.$inferSelect) {
  return {
    id: run.id,
    prompt: run.prompt,
    status: run.status,
    skillId: run.skillId,
    liveUrl: run.liveUrl,
    shortlist: run.shortlist ?? [],
    chosen: run.chosenJobUrl
      ? { url: run.chosenJobUrl, title: run.chosenJobTitle, company: run.chosenJobCompany }
      : null,
    filledFields: run.filledFields ?? [],
    blockedFields: run.blockedFields ?? [],
    pendingQuestion: run.pendingQuestion,
    dryRun: run.dryRun,
    emailSentAt: run.emailSentAt?.toISOString() ?? null,
    applicationId: run.applicationId,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  }
}

playgroundRouter.get(
  '/runs',
  asyncHandler(async (req, res) => {
    const runs = await listRuns(currentUser(req).id)
    ok(res, runs.map(runDto))
  }),
)

playgroundRouter.post(
  '/runs',
  validate({ body: startSchema }),
  asyncHandler(async (req, res) => {
    if (!hasRedis) {
      throw serviceUnavailable('The playground needs a queue. Set REDIS_URL.')
    }
    const user = currentUser(req)
    const body = req.body as z.infer<typeof startSchema>

    const [run] = await db
      .insert(playgroundRuns)
      .values({ userId: user.id, prompt: body.prompt, dryRun: env.APPLY_DRY_RUN })
      .returning()
    if (!run) throw new Error('Could not create a playground run')

    try {
      await say({ id: run.id, userId: user.id }, 'user', body.prompt)

      // One attempt. A run that failed halfway has already said so, and quietly
      // opening a second browser to redo an application is the last thing
      // anybody wants.
      await getQueue<PlaygroundJobData>(QUEUE.playground).add(
        'run',
        { userId: user.id, runId: run.id },
        { attempts: 1, removeOnComplete: 50, removeOnFail: 50, jobId: `playground-${run.id}` },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await setState({ id: run.id, userId: user.id }, {
        status: 'failed',
        error: `Could not queue this run: ${message}`,
        completedAt: new Date(),
      }).catch(() => undefined)
      await say({ id: run.id, userId: user.id }, 'huntly', 'I could not queue this run. Nothing was started.', 'stuck').catch(
        () => undefined,
      )
      throw error
    }

    created(res, runDto(run))
  }),
)

playgroundRouter.get(
  '/runs/:id',
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req)
    const run = await loadRun(String(req.params.id), user.id)
    const messages = await listMessages(run.id)
    ok(res, {
      run: runDto(run),
      messages: messages.map((message) => ({
        id: message.id,
        speaker: message.speaker,
        body: message.body,
        kind: message.kind,
        at: message.createdAt.toISOString(),
      })),
    })
  }),
)

/** Approving the match. Nothing is applied to until this is called. */
playgroundRouter.post(
  '/runs/:id/apply',
  validate({ params: idSchema, body: approveSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req)
    const run = await loadRun(String(req.params.id), user.id)
    if (run.status !== 'shortlisted') {
      throw conflict('This run is not waiting for approval.')
    }
    const body = req.body as z.infer<typeof approveSchema>
    await postReply(run.id, { kind: 'approve', text: body.url ?? run.chosenJobUrl ?? '' })
    ok(res, { ok: true })
  }),
)

/** Answering the question the run is blocked on. */
playgroundRouter.post(
  '/runs/:id/answer',
  validate({ params: idSchema, body: textSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req)
    const run = await loadRun(String(req.params.id), user.id)
    if (run.status !== 'blocked') throw conflict('This run is not waiting on an answer.')
    const body = req.body as z.infer<typeof textSchema>
    await postReply(run.id, { kind: 'answer', text: body.text })
    ok(res, { ok: true })
  }),
)

/**
 * Anything else the user types.
 *
 * When the run is blocked this *is* the answer — expecting somebody to notice
 * which of two boxes to type in would be a bad way to lose the one reply the
 * run was waiting for. Otherwise it is recorded and shown, and the run reads
 * it on its next step.
 */
playgroundRouter.post(
  '/runs/:id/message',
  validate({ params: idSchema, body: textSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req)
    const run = await loadRun(String(req.params.id), user.id)
    if (!LIVE.has(run.status)) throw conflict('This run has finished.')
    const body = req.body as z.infer<typeof textSchema>

    if (run.status === 'blocked') {
      await postReply(run.id, { kind: 'answer', text: body.text })
    } else {
      await say({ id: run.id, userId: user.id }, 'user', body.text)
      await postReply(run.id, { kind: 'instruct', text: body.text })
    }
    ok(res, { ok: true })
  }),
)

playgroundRouter.post(
  '/runs/:id/cancel',
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req)
    const run = await loadRun(String(req.params.id), user.id)
    if (!LIVE.has(run.status)) throw badRequest('This run has already finished.')
    await postReply(run.id, { kind: 'cancel', text: 'stop' })
    ok(res, { ok: true })
  }),
)
