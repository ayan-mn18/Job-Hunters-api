import { Redis } from 'ioredis'
import { env, hasRedis } from '../config/env.js'
import { serviceUnavailable } from './errors.js'
import { logger } from './logger.js'

/**
 * One Redis connection per process, shared by every queue and lock.
 *
 * BullMQ opens its own blocking connections for workers, so this is not the
 * only socket the process holds — but queue producers, locks and rate counters
 * all belong on one connection rather than one each. Before this existed,
 * `application-queue.ts` built its own and nothing else could reach it.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: it manages its own retry
 * semantics and a client that gives up mid-command breaks the worker loop.
 */

let client: Redis | undefined

export function getRedis(): Redis {
  if (!hasRedis || !env.REDIS_URL) {
    throw serviceUnavailable('REDIS_URL is required for queues, locks and scheduling.')
  }
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
    client.on('error', (error) => {
      logger.error({ err: error }, 'redis connection errored')
    })
  }
  return client
}

export async function closeRedis(): Promise<void> {
  const current = client
  client = undefined
  if (current) await current.quit()
}
