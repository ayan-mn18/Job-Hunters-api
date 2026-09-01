import { EventEmitter } from 'node:events'
import { getRedis } from '../../lib/redis.js'
import { logger } from '../../lib/logger.js'
import { hasRedis } from '../../config/env.js'

/**
 * Attempt events, from the runner to whoever is watching.
 *
 * The producer is the runner process and the consumer is the API process, so
 * this cannot be a plain in-process emitter — it goes over Redis pub/sub, with
 * a local emitter on each side. That is also why the channel is per user: a
 * frame from someone else's application must never reach this socket.
 *
 * Delivery is deliberately lossy. A dropped frame means a slightly stale
 * picture; blocking an application on a subscriber that stopped reading would
 * be much worse.
 */

export interface AttemptStateEvent {
  type: 'state'
  attemptId: string
  state: string
  reason: string | null
  detail: Record<string, unknown> | null
  at: string
}

export interface AttemptFrameEvent {
  type: 'frame'
  attemptId: string
  seq: number
  /** JPEG, base64. Small and frequent. */
  data: string
}

export interface AttemptFieldEvent {
  type: 'field'
  attemptId: string
  label: string
  /** How it was resolved: which rung of the ladder answered. */
  via: 'recipe' | 'heuristic' | 'cache' | 'model' | 'skipped'
  /** Never the value itself — a form field can hold a phone number. */
  filled: boolean
}

export type AttemptEventPayload = AttemptStateEvent | AttemptFrameEvent | AttemptFieldEvent

const local = new EventEmitter()
// One live view can attach several listeners; the default of 10 is low for a
// process serving a handful of concurrent watchers.
local.setMaxListeners(100)

function channelFor(userId: string): string {
  return `huntly:attempt:${userId}`
}

let subscriber: ReturnType<typeof getRedis> | undefined
const subscribed = new Set<string>()

/** Publishes to Redis so the API process can forward it to the browser. */
export function publishAttemptEvent(userId: string, payload: AttemptEventPayload): void {
  local.emit(userId, payload)
  if (!hasRedis) return
  void getRedis()
    .publish(channelFor(userId), JSON.stringify(payload))
    .catch((error: unknown) => {
      logger.debug({ err: error }, 'could not publish an attempt event')
    })
}

/**
 * Watches one user's attempts. Returns an unsubscribe function.
 *
 * The Redis subscription is opened once per user and left open while anyone is
 * listening; the local emitter fans out to multiple watchers of the same user.
 */
export function subscribeToAttempts(
  userId: string,
  listener: (payload: AttemptEventPayload) => void,
): () => void {
  local.on(userId, listener)

  if (hasRedis && !subscribed.has(userId)) {
    subscribed.add(userId)
    // A subscribed Redis connection cannot issue normal commands, so this is a
    // dedicated duplicate rather than the shared client.
    subscriber ??= getRedis().duplicate()
    void subscriber.subscribe(channelFor(userId)).catch((error: unknown) => {
      logger.warn({ err: error, userId }, 'could not subscribe to attempt events')
    })
    subscriber.on('message', (channel: string, message: string) => {
      if (channel !== channelFor(userId)) return
      try {
        local.emit(userId, JSON.parse(message) as AttemptEventPayload)
      } catch {
        // A malformed frame is not worth failing a live view over.
      }
    })
  }

  return () => {
    local.off(userId, listener)
  }
}

export async function closeAttemptEvents(): Promise<void> {
  const current = subscriber
  subscriber = undefined
  subscribed.clear()
  local.removeAllListeners()
  if (current) await current.quit().catch(() => undefined)
}
