import { logger } from '../lib/logger.js'

/**
 * ============================ STUBBED WORKSTREAM ============================
 * Scraping, scoring, resume tailoring and form-filling are a BullMQ worker
 * owned by another agent. This API never runs that work — it only records a
 * `hunt_runs` row and hands the id over.
 *
 * The contract is one-directional and deliberately thin:
 *   API  → queue:  "run <runId> for user <userId>, target N applications"
 *   API  → queue:  "stop <runId>"
 *   worker → DB:   updates hunt_runs.progress / status, inserts applications
 *                  and activity_events
 *
 * The worker owning the writes (rather than calling back into HTTP) means a
 * long run does not depend on this process staying up.
 *
 * TODO(worker-workstream): register a BullMQ-backed implementation via
 * `setHuntQueue()` at boot. See docs/.
 * ===========================================================================
 */

export interface HuntJobRequest {
  runId: string
  userId: string
  targetApplications: number
  minMatchScore: number
  roles: string[]
  locations: string[]
  dreamCompanies: string[]
  dealBreakers: string[]
  portalIds: string[]
  baseResumeId: string | null
}

export interface HuntQueue {
  readonly name: string
  readonly isReal: boolean
  /** Enqueue a run. Resolves once accepted, not once finished. */
  enqueue(request: HuntJobRequest): Promise<{ jobId: string }>
  /** Ask a running job to wind down. Best effort. */
  requestStop(runId: string): Promise<void>
}

/** Accepts and drops. The `hunt_runs` row stays `queued` forever, honestly. */
class StubHuntQueue implements HuntQueue {
  readonly name = 'stub'
  readonly isReal = false

  async enqueue(request: HuntJobRequest): Promise<{ jobId: string }> {
    logger.warn(
      { runId: request.runId, userId: request.userId, target: request.targetApplications },
      'hunt queue is stubbed — the run was recorded but nothing will execute',
    )
    return { jobId: `stub:${request.runId}` }
  }

  async requestStop(runId: string): Promise<void> {
    logger.warn({ runId }, 'hunt queue is stubbed — stop request recorded only')
  }
}

let queue: HuntQueue = new StubHuntQueue()

export function getHuntQueue(): HuntQueue {
  return queue
}

export function setHuntQueue(next: HuntQueue): void {
  queue = next
  logger.info({ queue: next.name, isReal: next.isReal }, 'hunt queue registered')
}
