import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { applyAttempts, playgroundRuns } from '../db/schema.js'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { verifyAccessToken } from '../lib/jwt.js'
import { subscribeToAttempts, type AttemptEventPayload } from '../hunt/apply/events.js'
import { markWatching, sendTakeover, stopWatching, type TakeoverEvent } from '../hunt/apply/screencast.js'
import { subscribeToPlayground, type PlaygroundEvent } from '../playground/events.js'

/**
 * The live view socket.
 *
 * Attaches to the existing HTTP server rather than opening a second port, so
 * there is one thing to expose and one origin for the browser to trust.
 *
 * Two rules make this safe to run next to the API. Every socket is
 * authenticated before it is accepted, and a socket only ever receives events
 * for attempts belonging to the user who opened it — a frame from someone
 * else's application must never reach it.
 */

const PATH = /^\/live\/([0-9a-f-]{36})$/i
/** Playground runs get their own path so the two id spaces cannot collide. */
const PLAYGROUND_PATH = /^\/live\/playground\/([0-9a-f-]{36})$/i

/** Refreshed while a socket is open so the runner knows to keep streaming. */
const WATCH_REFRESH_MS = 20_000

interface Client {
  socket: WebSocket
  userId: string
  attemptId: string
  unsubscribe: () => void
  refresh: NodeJS.Timeout
}

export function attachLiveGateway(server: Server): WebSocketServer {
  // `noServer` so the upgrade can be rejected before a socket exists — an
  // unauthenticated client should never reach an open WebSocket.
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host ?? 'localhost'}`)
    const playground = PLAYGROUND_PATH.exec(url.pathname)
    const match = playground ?? PATH.exec(url.pathname)
    if (!match) {
      socket.destroy()
      return
    }

    const attemptId = match[1]
    // A browser WebSocket cannot set an Authorization header, so the token
    // arrives as a query parameter. It is short-lived and the connection is
    // same-origin.
    const token = url.searchParams.get('token') ?? ''
    let userId: string
    try {
      userId = verifyAccessToken(token).sub
    } catch {
      socket.destroy()
      return
    }

    if (playground) {
      void (async () => {
        // The run must belong to this user. Without this check any
        // authenticated user could watch anyone's application being filled in.
        const [run] = await db
          .select({ id: playgroundRuns.id })
          .from(playgroundRuns)
          .where(and(eq(playgroundRuns.id, attemptId!), eq(playgroundRuns.userId, userId)))
          .limit(1)
          .catch(() => [])

        if (!run) {
          socket.destroy()
          return
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          acceptPlayground(ws, userId, attemptId!)
        })
      })()
      return
    }

    void (async () => {
      // The attempt must belong to this user. Without this check any
      // authenticated user could watch anyone's application.
      const [attempt] = await db
        .select({ id: applyAttempts.id })
        .from(applyAttempts)
        .where(and(eq(applyAttempts.id, attemptId!), eq(applyAttempts.userId, userId)))
        .limit(1)
        .catch(() => [])

      if (!attempt) {
        socket.destroy()
        return
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        accept(ws, userId, attemptId!)
      })
    })()
  })

  function accept(socket: WebSocket, userId: string, attemptId: string): void {
    void markWatching(attemptId)

    const unsubscribe = subscribeToAttempts(userId, (payload: AttemptEventPayload) => {
      // One socket watches one attempt; everything else on this user's channel
      // belongs to a different tab.
      if (payload.attemptId !== attemptId) return
      if (socket.readyState !== socket.OPEN) return
      socket.send(JSON.stringify(payload), () => undefined)
    })

    const refresh = setInterval(() => void markWatching(attemptId), WATCH_REFRESH_MS)
    refresh.unref()

    const client: Client = { socket, userId, attemptId, unsubscribe, refresh }

    socket.on('message', (raw) => {
      let event: TakeoverEvent
      try {
        event = JSON.parse(String(raw)) as TakeoverEvent
      } catch {
        return
      }
      if (!['click', 'key', 'scroll', 'release'].includes(event.kind)) return
      void sendTakeover(attemptId, event)
    })

    socket.on('close', () => close(client))
    socket.on('error', () => close(client))

    socket.send(
      JSON.stringify({ type: 'ready', attemptId, takeoverWindowMs: env.APPLY_TAKEOVER_WINDOW_MS }),
      () => undefined,
    )
  }

  /**
   * A playground socket.
   *
   * Read-only, unlike the apply one. There is no takeover channel to forward
   * clicks over because the hosted browser publishes its own live URL and the
   * user clicks in the real thing — anything typed instead goes over HTTP,
   * where it can be validated and recorded.
   */
  function acceptPlayground(socket: WebSocket, userId: string, runId: string): void {
    const unsubscribe = subscribeToPlayground(userId, (payload: PlaygroundEvent) => {
      // One socket watches one run; everything else on this user's channel
      // belongs to a different tab.
      if (payload.runId !== runId) return
      if (socket.readyState !== socket.OPEN) return
      socket.send(JSON.stringify(payload), () => undefined)
    })

    socket.on('close', unsubscribe)
    socket.on('error', unsubscribe)
    socket.send(JSON.stringify({ type: 'ready', runId }), () => undefined)
  }

  function close(client: Client): void {
    clearInterval(client.refresh)
    client.unsubscribe()
    void stopWatching(client.attemptId)
  }

  logger.info('live view gateway attached')
  return wss
}
