import { EventEmitter } from 'node:events'
import { hasRedis } from '../config/env.js'
import { getRedis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'

/**
 * Playground events, from the runner to whoever is watching.
 *
 * Same shape as the apply live view and for the same reason: the producer is
 * the runner and the consumer is the API, so it cannot be an in-process
 * emitter. Keyed per user, because a run belonging to someone else must never
 * reach this socket.
 *
 * Unlike the apply stream there are no frames here — the hosted browser
 * publishes its own live URL and the UI embeds that — so every event is small
 * and worth delivering. It is still best-effort: a dropped event costs a stale
 * panel, and blocking a live application on a stalled subscriber would not.
 */

export interface RunStateEvent {
  type: 'state'
  runId: string
  status: string
  /** Whatever changed with it: liveUrl on launch, shortlist on search. */
  detail: Record<string, unknown> | null
  at: string
}

export interface RunMessageEvent {
  type: 'message'
  runId: string
  speaker: 'huntly' | 'agent' | 'llm' | 'user' | 'system'
  body: string
  kind: string | null
  at: string
}

/** One step the browser agent took. Rendered as a line, not a bubble. */
export interface RunStepEvent {
  type: 'step'
  runId: string
  index: number
  tool: string
  result: string
  ok: boolean
}

export type PlaygroundEvent = RunStateEvent | RunMessageEvent | RunStepEvent

const local = new EventEmitter()
local.setMaxListeners(100)

function channelFor(userId: string): string {
  return `huntly:playground:${userId}`
}

let subscriber: ReturnType<typeof getRedis> | undefined
const subscribed = new Set<string>()

export function publishPlaygroundEvent(userId: string, payload: PlaygroundEvent): void {
  local.emit(userId, payload)
  if (!hasRedis) return
  void getRedis()
    .publish(channelFor(userId), JSON.stringify(payload))
    .catch((error: unknown) => {
      logger.debug({ err: error }, 'could not publish a playground event')
    })
}

export function subscribeToPlayground(
  userId: string,
  listener: (payload: PlaygroundEvent) => void,
): () => void {
  local.on(userId, listener)

  if (hasRedis && !subscribed.has(userId)) {
    subscribed.add(userId)
    // A subscribed connection cannot issue normal commands, so this is a
    // dedicated duplicate rather than the shared client.
    subscriber ??= getRedis().duplicate()
    void subscriber.subscribe(channelFor(userId)).catch((error: unknown) => {
      logger.warn({ err: error, userId }, 'could not subscribe to playground events')
    })
    subscriber.on('message', (channel: string, message: string) => {
      if (channel !== channelFor(userId)) return
      try {
        local.emit(userId, JSON.parse(message) as PlaygroundEvent)
      } catch {
        // A malformed event is not worth failing a live view over.
      }
    })
  }

  return () => {
    local.off(userId, listener)
  }
}

export async function closePlaygroundEvents(): Promise<void> {
  const current = subscriber
  subscriber = undefined
  subscribed.clear()
  local.removeAllListeners()
  if (current) await current.quit().catch(() => undefined)
}
