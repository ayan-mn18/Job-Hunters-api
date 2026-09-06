/**
 * Every queue name in one place, with the shape of what goes on it.
 *
 * `apply` keeps its original unprefixed name. Renaming it would orphan any job
 * already sitting in Redis, and a queue rename is not worth a lost application.
 */

// BullMQ rejects a colon in a queue name — it uses one as its own Redis key
// separator — so these are hyphenated.
export const QUEUE = {
  discover: 'huntly-discover',
  rerank: 'huntly-rerank',
  apply: 'hunt-apply',
  session: 'huntly-session',
  inbox: 'huntly-inbox',
  referralSync: 'huntly-referral-sync',
  outreach: 'huntly-outreach',
  learn: 'huntly-learn',
} as const

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE]

/** Queues whose jobs need a real browser, and so run on the runner process. */
export const BROWSER_QUEUES: QueueName[] = [
  QUEUE.apply,
  QUEUE.session,
  QUEUE.referralSync,
  QUEUE.outreach,
]

/** Queues that are pure CPU and IO, and so run on the worker process. */
export const WORKER_QUEUES: QueueName[] = [QUEUE.discover, QUEUE.rerank, QUEUE.inbox, QUEUE.learn]

export interface DiscoverJobData {
  userId: string
  /**
   * Null on scheduled runs: a repeatable job's payload is fixed at
   * registration time and cannot carry a run id that must be new on every
   * fire, so the worker creates the row when it picks the job up.
   */
  runId: string | null
  targetApplications: number | null
  /** `daily` runs are scheduled; `manual` came from a button. */
  trigger: 'manual' | 'daily'
}

export interface ReferralSyncJobData {
  userId: string
  /** How many days back to sweep. First sync looks further. */
  days: number
}

export interface InboxJobData {
  userId: string
}

export interface ApplyJobData {
  userId: string
  runId: string
  candidateId: string
  portal: string
}

export interface OutreachJobData {
  userId: string
}
