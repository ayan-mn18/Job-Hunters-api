import { eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { applyAttempts, attemptEvents } from '../../db/schema.js'
import { logger } from '../../lib/logger.js'
import { publishAttemptEvent } from './events.js'

/**
 * An application attempt, as states rather than a straight line.
 *
 * The old function ran fill → submit → hope. When it stopped somewhere it
 * wrote `needs_review` and nothing else: the user learned the application had
 * failed and could learn nothing further, because there was no vocabulary for
 * *where* it stopped. Every transition here is recorded and pushed to whoever
 * is watching.
 */

export type AttemptState =
  | 'queued'
  | 'opening'
  | 'filling'
  | 'blocked'
  | 'submitting'
  | 'submitted'
  | 'failed'
  | 'skipped'

/** Why an attempt is blocked. Each one needs a different response. */
export type BlockedReason =
  /** A required field we could not answer. The user can answer it. */
  | 'needs_input'
  /** A CAPTCHA. Only a human can pass it, and that is by design. */
  | 'captcha'
  /** The portal wants an account we do not have a session for. */
  | 'login_required'
  /** A question we have never seen and could not map. */
  | 'unknown_field'
  /** A field we will not answer on the user's behalf without permission. */
  | 'sensitive_field'

export interface TransitionInput {
  attemptId: string
  userId: string
  state: AttemptState
  reason?: BlockedReason
  detail?: Record<string, unknown>
}

/** Which `apply_attempts.status` each state corresponds to. */
const STATUS_FOR: Partial<Record<AttemptState, string>> = {
  submitting: 'submitting',
  submitted: 'submitted',
  blocked: 'needs_review',
  failed: 'failed',
}

/**
 * Records a transition and tells anyone watching.
 *
 * Writing the event is best-effort in one direction only: the attempt's own
 * status write must succeed, but a failed event row or a dropped WebSocket
 * frame must never take down the application it was describing.
 */
export async function transition(input: TransitionInput): Promise<void> {
  const { attemptId, userId, state, reason, detail } = input

  try {
    await db.insert(attemptEvents).values({
      attemptId,
      state,
      reason: reason ?? null,
      detail: detail ?? null,
    })
  } catch (error) {
    logger.warn({ err: error, attemptId, state }, 'could not record an attempt event')
  }

  const status = STATUS_FOR[state]
  if (status) {
    await db
      .update(applyAttempts)
      .set({
        status: status as never,
        ...(state === 'submitted' || state === 'failed' || state === 'blocked'
          ? { completedAt: new Date() }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(applyAttempts.id, attemptId))
  }

  publishAttemptEvent(userId, {
    type: 'state',
    attemptId,
    state,
    reason: reason ?? null,
    detail: detail ?? null,
    at: new Date().toISOString(),
  })
}

/** The full history of one attempt, oldest first. */
export async function attemptTimeline(attemptId: string) {
  return db
    .select()
    .from(attemptEvents)
    .where(eq(attemptEvents.attemptId, attemptId))
    .orderBy(attemptEvents.at)
}
