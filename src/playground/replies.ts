import { hasRedis } from '../config/env.js'
import { getRedis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'

/**
 * Waiting for a person, from a process that cannot see them.
 *
 * The run happens on the runner; the reply arrives at the API. Between them
 * is Redis, and the handoff is a list with a blocking pop rather than pub/sub
 * on purpose: an answer typed a second before the runner started listening
 * would be published into an empty room and lost, and losing the one answer
 * somebody was asked for is the worst failure this feature has.
 *
 * A list holds it until it is collected.
 */

function key(runId: string): string {
  return `huntly:playground:reply:${runId}`
}

/** How long a queued answer survives if the run has already gone away. */
const REPLY_TTL_SECONDS = 30 * 60

export type ReplyKind = 'answer' | 'approve' | 'cancel' | 'instruct'

export interface Reply {
  kind: ReplyKind
  /** The answer, the instruction, or the chosen job's URL for `approve`. */
  text: string
}

export async function postReply(runId: string, reply: Reply): Promise<void> {
  if (!hasRedis) throw new Error('REDIS_URL is required for playground runs.')
  const redis = getRedis()
  await redis.rpush(key(runId), JSON.stringify(reply))
  await redis.expire(key(runId), REPLY_TTL_SECONDS)
}

/**
 * Blocks until somebody sends one of the replies being waited for, or the
 * deadline passes.
 *
 * `accept` is not optional politeness — it is what stops a message typed while
 * the run was still searching from being popped later and mistaken for the
 * approval to send an application. Anything not being waited for is dropped
 * here rather than acted on.
 *
 * A dedicated connection: `BLPOP` occupies the client for its whole timeout,
 * and the shared one is also serving queue and lock traffic.
 */
export async function awaitReply(
  runId: string,
  timeoutMs: number,
  accept: ReplyKind[],
): Promise<Reply | null> {
  if (!hasRedis) return null
  const client = getRedis().duplicate()
  try {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000)
      if (remaining <= 0) return null
      // BLPOP takes whole seconds and treats 0 as "wait forever", which is
      // exactly what a run that has been abandoned must not do.
      const popped = await client.blpop(key(runId), Math.max(1, Math.min(remaining, 30)))
      if (!popped) continue

      let reply: Reply
      try {
        reply = JSON.parse(popped[1]) as Reply
      } catch {
        logger.warn({ runId }, 'discarded an unreadable playground reply')
        continue
      }

      if (accept.includes(reply.kind)) return reply
      logger.debug({ runId, kind: reply.kind, accept }, 'dropped a reply nothing was waiting for')
    }
  } finally {
    await client.quit().catch(() => undefined)
  }
}

/** Drops anything queued for a run that has finished. */
export async function clearReplies(runId: string): Promise<void> {
  if (!hasRedis) return
  await getRedis().del(key(runId)).catch(() => undefined)
}
