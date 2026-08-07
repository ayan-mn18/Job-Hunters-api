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

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as { requestId?: string }).requestId ?? crypto.randomUUID(),
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error'
    if (res.statusCode >= 400) return 'warn'
    return 'info'
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
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
