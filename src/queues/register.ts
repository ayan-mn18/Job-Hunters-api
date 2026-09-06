import { hasRedis } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { setHuntQueue } from '../services/hunt-queue.js'
import { setReferralDraftGenerator } from '../services/referral-draft.js'
import { registerReferralDraftGenerator } from '../services/referral-draft-model.js'
import { createHuntQueue } from './discover.js'

/**
 * Swaps the stubbed seams for their real implementations.
 *
 * Called by every entrypoint — api, worker and runner — because a producer
 * needs the real queue just as much as a consumer does. Without Redis the
 * stubs stay, and the process still boots and still serves `/healthz`.
 */
export function registerQueueImplementations(): void {
  // The drafter is independent of Redis — a deployment with no queue should
  // still write real referral drafts.
  registerReferralDraftGenerator(setReferralDraftGenerator)

  if (!hasRedis) {
    logger.warn('REDIS_URL is not set — hunt runs will be recorded but never executed.')
    return
  }
  setHuntQueue(createHuntQueue())
}
