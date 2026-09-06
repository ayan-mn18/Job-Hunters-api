import type { Page } from 'playwright-core'
import { logger } from '../../lib/logger.js'
import { getRedis } from '../../lib/redis.js'
import { hasRedis } from '../../config/env.js'
import { publishAttemptEvent } from './events.js'

/**
 * Streaming what the browser is doing, while it does it.
 *
 * Uses CDP's own screencast rather than a screenshot loop: Chrome pushes a
 * frame when the page actually changes, so an idle form costs nothing and a
 * fast-filling one stays smooth.
 *
 * Two things keep this from being expensive. Frames are only produced while
 * somebody is watching — the runner checks a Redis key the gateway maintains —
 * and they are capped, because a form being filled generates far more frames
 * than a person can perceive.
 */

/** Roughly five frames a second is smooth enough to follow and cheap to send. */
const MIN_FRAME_GAP_MS = 200

function watcherKey(attemptId: string): string {
  return `huntly:watching:${attemptId}`
}

/** The gateway sets this while a browser has the live view open. */
export async function markWatching(attemptId: string, ttlSeconds = 60): Promise<void> {
  if (!hasRedis) return
  await getRedis().set(watcherKey(attemptId), '1', 'EX', ttlSeconds).catch(() => undefined)
}

export async function stopWatching(attemptId: string): Promise<void> {
  if (!hasRedis) return
  await getRedis().del(watcherKey(attemptId)).catch(() => undefined)
}

export async function isWatched(attemptId: string): Promise<boolean> {
  if (!hasRedis) return false
  return (await getRedis().exists(watcherKey(attemptId)).catch(() => 0)) === 1
}

export interface Screencast {
  stop: () => Promise<void>
}

/**
 * Starts streaming a page to whoever is watching this attempt.
 *
 * Never throws: a live view that cannot start is a missing convenience, and
 * failing the application it was meant to show would be a poor trade.
 */
export async function startScreencast(params: {
  page: Page
  userId: string
  attemptId: string
}): Promise<Screencast> {
  const { page, userId, attemptId } = params
  let stopped = false
  let seq = 0
  let lastFrameAt = 0

  try {
    const session = await page.context().newCDPSession(page)

    session.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
      // Acknowledge every frame or Chrome stops sending them, even the ones
      // we drop for pacing.
      void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
      if (stopped) return

      const now = Date.now()
      if (now - lastFrameAt < MIN_FRAME_GAP_MS) return
      lastFrameAt = now

      seq += 1
      publishAttemptEvent(userId, { type: 'frame', attemptId, seq, data: frame.data })
    })

    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 55,
      maxWidth: 1000,
      maxHeight: 720,
      everyNthFrame: 1,
    })

    return {
      async stop() {
        stopped = true
        await session.send('Page.stopScreencast').catch(() => undefined)
        await session.detach().catch(() => undefined)
      },
    }
  } catch (error) {
    logger.debug({ err: error, attemptId }, 'could not start the screencast')
    return { stop: async () => undefined }
  }
}

/* ------------------------------------------------------------------ takeover */

export interface TakeoverEvent {
  kind: 'click' | 'key' | 'scroll' | 'release'
  x?: number
  y?: number
  text?: string
  deltaY?: number
}

function controlKey(attemptId: string): string {
  return `huntly:takeover:${attemptId}`
}

/** The gateway publishes the user's input here; the runner applies it. */
export async function sendTakeover(attemptId: string, event: TakeoverEvent): Promise<void> {
  if (!hasRedis) return
  await getRedis().publish(controlKey(attemptId), JSON.stringify(event)).catch(() => undefined)
}

/**
 * Hands the page to the user for a while.
 *
 * The runner stops driving and forwards input instead — this is a takeover of
 * the same browser, not a video of one. It ends on an explicit release or when
 * the window expires, and the attempt carries on from wherever the user left
 * the page.
 */
export async function awaitTakeover(params: {
  page: Page
  attemptId: string
  windowMs: number
}): Promise<'released' | 'timeout'> {
  const { page, attemptId, windowMs } = params
  if (!hasRedis) return 'timeout'

  const subscriber = getRedis().duplicate()
  const { promise, resolve } = Promise.withResolvers<'released' | 'timeout'>()

  const timer = setTimeout(() => resolve('timeout'), windowMs)
  timer.unref()

  try {
    await subscriber.subscribe(controlKey(attemptId))
    subscriber.on('message', (_channel: string, message: string) => {
      let event: TakeoverEvent
      try {
        event = JSON.parse(message) as TakeoverEvent
      } catch {
        return
      }

      if (event.kind === 'release') {
        resolve('released')
        return
      }

      // Applied best-effort: a mistyped coordinate should not end the takeover.
      void (async () => {
        try {
          if (event.kind === 'click' && typeof event.x === 'number' && typeof event.y === 'number') {
            await page.mouse.click(event.x, event.y)
          } else if (event.kind === 'key' && event.text) {
            await page.keyboard.type(event.text)
          } else if (event.kind === 'scroll' && typeof event.deltaY === 'number') {
            await page.mouse.wheel(0, event.deltaY)
          }
        } catch (error) {
          logger.debug({ err: error, attemptId }, 'could not apply a takeover event')
        }
      })()
    })

    return await promise
  } finally {
    clearTimeout(timer)
    await subscriber.quit().catch(() => undefined)
  }
}
