import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq'
import { hasRedis } from '../config/env.js'
import { serviceUnavailable } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { getRedis } from '../lib/redis.js'
import type { QueueName } from './names.js'

/**
 * Queue and worker construction, in one place.
 *
 * Producers (the API) only ever call `getQueue`. Consumers (worker, runner)
 * call `startWorker`. Neither builds its own Redis connection — see lib/redis.
 */

const queues = new Map<string, Queue>()
const workers: Worker[] = []

export function assertQueuesConfigured(): void {
  if (!hasRedis) {
    throw serviceUnavailable('REDIS_URL is required before background work can be queued.')
  }
}

export function getQueue<T = unknown>(name: QueueName): Queue<T> {
  assertQueuesConfigured()
  let queue = queues.get(name)
  if (!queue) {
    queue = new Queue(name, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 7 * 86_400, count: 5_000 },
        removeOnFail: { age: 30 * 86_400 },
      },
    })
    queues.set(name, queue)
  }
  return queue as Queue<T>
}

export function startWorker<T = unknown>(
  name: QueueName,
  processor: Processor<T>,
  options: Partial<WorkerOptions> = {},
): Worker<T> {
  assertQueuesConfigured()
  const worker = new Worker<T>(name, processor, {
    connection: getRedis(),
    concurrency: 1,
    ...options,
  })

  worker.on('failed', (job, error) => {
    logger.error({ err: error, queue: name, jobId: job?.id, data: job?.data }, 'job failed')
  })
  worker.on('error', (error) => {
    logger.error({ err: error, queue: name }, 'worker errored')
  })

  workers.push(worker)
  logger.info({ queue: name, concurrency: options.concurrency ?? 1 }, 'worker started')
  return worker
}

/** Closes workers before queues, so nothing is mid-job when the client goes. */
export async function closeQueues(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()))
  workers.length = 0
  await Promise.all([...queues.values()].map((queue) => queue.close()))
  queues.clear()
}
