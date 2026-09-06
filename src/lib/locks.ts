import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { getRedis } from './redis.js'

/**
 * Per-user, per-resource mutual exclusion.
 *
 * The invariant this exists to hold: **one live browser session per user per
 * resource, ever.** Two tabs driving the same LinkedIn account in parallel is
 * both a correctness bug (they fight over navigation) and the fastest way to
 * look like automation to the portal.
 *
 * Generalised from the `withPortalLock` that lived inside the apply queue,
 * which was the same idea limited to one caller.
 */

export type LockResource =
  | `portal:${string}`
  | `linkedin`
  | `outreach`
  | `inbox`
  | `discover`

export interface LockOptions {
  /**
   * How long the lock survives without a heartbeat.
   *
   * Short on purpose. The lock is renewed while the operation runs, so this is
   * not a ceiling on how long work may take — it is how long a *dead* holder
   * blocks everyone else. A long TTL here is how a crashed worker locks a user
   * out of their own discovery run for a quarter of an hour.
   */
  ttlMs?: number
  /** How long to wait for the lock before giving up. */
  waitMs?: number
  /** Gap between acquisition attempts. */
  pollMs?: number
}

export class LockBusyError extends Error {
  constructor(key: string, waitedMs: number) {
    super(`Resource ${key} stayed busy for ${Math.round(waitedMs / 1000)}s.`)
    this.name = 'LockBusyError'
  }
}

const RELEASE_IF_MINE = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`

/** Extends the TTL only while we still hold the lock, never blindly. */
const RENEW_IF_MINE = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`

export async function withUserResourceLock<T>(
  userId: string,
  resource: LockResource,
  operation: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const ttlMs = options.ttlMs ?? 60_000
  const waitMs = options.waitMs ?? 15 * 60_000
  const pollMs = options.pollMs ?? 5_000

  const redis = getRedis()
  const key = `huntly:lock:${userId}:${resource}`
  const token = crypto.randomUUID()
  const startedAt = Date.now()
  const deadline = startedAt + waitMs

  let acquired = false
  while (!acquired) {
    acquired = (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK'
    if (acquired) break
    if (Date.now() >= deadline) throw new LockBusyError(key, Date.now() - startedAt)
    await sleep(pollMs)
  }

  // Hold the lock open for as long as the work actually takes. Renewing at a
  // third of the TTL leaves room for two missed beats before anyone else can
  // take it, which is the difference between a slow network and a dead worker.
  const heartbeat = setInterval(() => {
    void redis.eval(RENEW_IF_MINE, 1, key, token, String(ttlMs)).catch(() => undefined)
  }, Math.max(1_000, Math.floor(ttlMs / 3)))
  heartbeat.unref()

  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    // Only delete a lock we still own. Without the token check, a caller that
    // overran its TTL would delete the lock a *different* worker now holds.
    await redis.eval(RELEASE_IF_MINE, 1, key, token)
  }
}

/** True when someone currently holds this lock. For status endpoints only. */
export async function isLocked(userId: string, resource: LockResource): Promise<boolean> {
  return (await getRedis().exists(`huntly:lock:${userId}:${resource}`)) === 1
}
