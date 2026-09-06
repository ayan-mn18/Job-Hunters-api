import { logger } from '../lib/logger.js'

/**
 * The seam between "a run was requested" and "a run is executing".
 *
 * The API records a `hunt_runs` row and hands the id over; the worker owns
 * every write after that. Keeping the direction one-way — worker writes to the
 * database rather than calling back into HTTP — means a long scrape does not
 * depend on the web process staying up.
 *
 * The real implementation lives in `queues/discover.ts` and is registered at
 * boot by `registerQueueImplementations()`. When Redis is absent the stub
 * below stays in place and says so, which is the honest failure: the run row
 * exists and nothing will execute it.
 */

export interface HuntJobRequest {
  runId: string
  userId: string
  targetApplications: number
  /**
   * Descriptive fields, all optional. The worker re-reads the spec, kit and
   * resume from the database rather than trusting a snapshot taken at enqueue
   * time — by the time a job runs, the user may have edited any of them.
   */
  minMatchScore?: number
  roles?: string[]
  locations?: string[]
  dreamCompanies?: string[]
  dealBreakers?: string[]
  portalIds?: string[]
  baseResumeId?: string | null
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
