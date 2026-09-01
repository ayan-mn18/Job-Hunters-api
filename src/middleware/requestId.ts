import crypto from 'node:crypto'
import type { RequestHandler } from 'express'
import { pinoHttp } from 'pino-http'
import { logger } from '../lib/logger.js'

/**
 * Every request gets an id, echoed back in the `x-request-id` header and in
 * every error body. When a user says "it broke", that string is the whole
 * debugging session.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.headers['x-request-id']
  const id = (Array.isArray(incoming) ? incoming[0] : incoming) || crypto.randomUUID()
  req.requestId = id
  res.setHeader('x-request-id', id)
  next()
}

/**
 * Server-side duration on every response.
 *
 * The browser's network tab shows total time, which mixes the server, the
 * network and the queue. Without this header there is no way to tell a slow
 * endpoint from a slow connection, and "the API feels slow" stays an opinion.
 */
export const responseTime: RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint()
  res.on('close', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    req.durationMs = ms
  })
  // Set on headers-flush rather than on close, which is too late to send it.
  const send = res.writeHead.bind(res)
  res.writeHead = ((...args: Parameters<typeof send>) => {
    if (!res.headersSent) {
      res.setHeader('x-response-time', `${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)}ms`)
    }
    return send(...args)
  }) as typeof res.writeHead
  next()
}

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as { requestId?: string }).requestId ?? crypto.randomUUID(),
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error'
    if (res.statusCode >= 400) return 'warn'
    return 'info'
  },
  customSuccessMessage: (req, res) => {
    const ms = (req as { durationMs?: number }).durationMs
    return `${req.method} ${req.url} → ${res.statusCode}${ms === undefined ? '' : ` (${ms.toFixed(0)}ms)`}`
  },
  // The error handler already logs failures with full context; this would only
  // duplicate them at a second severity.
  customErrorMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
  autoLogging: {
    ignore: (req) => req.url === '/healthz' || req.url === '/health',
  },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
})
