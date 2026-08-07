import { db } from '../db/client.js'
import { activityEvents, type ActivityKind } from '../db/schema.js'
import { logger } from '../lib/logger.js'

/**
 * "Hunty's trail" on the Den screen. Every module that changes something the
 * user would care about drops a line here.
 *
 * Recording activity must never be the reason a request fails — a broken feed
 * is a cosmetic problem, a failed job application is not. So this swallows its
 * errors and logs them.
 */

const DEFAULT_EMOJI: Record<ActivityKind, string> = {
  application_submitted: '📮',
  application_status_changed: '👀',
  resume_tailored: '✂️',
  resume_uploaded: '📄',
  jobs_scraped: '🔎',
  referral_received: '🤝',
  referral_handled: '✅',
  hunt_started: '🎯',
  hunt_stopped: '🛑',
  portal_connected: '🌐',
  portal_disconnected: '🔌',
  account_created: '🎉',
  onboarding_completed: '🚀',
}

export async function recordActivity(input: {
  userId: string
  kind: ActivityKind
  text: string
  emoji?: string
  meta?: Record<string, unknown>
}): Promise<void> {
  try {
    await db.insert(activityEvents).values({
      userId: input.userId,
      kind: input.kind,
      emoji: input.emoji ?? DEFAULT_EMOJI[input.kind],
      text: input.text,
      meta: input.meta ?? null,
    })
  } catch (error) {
    logger.warn({ err: error, kind: input.kind, userId: input.userId }, 'could not record activity')
  }
}
