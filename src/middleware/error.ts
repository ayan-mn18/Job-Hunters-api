import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express'
import multer from 'multer'
import { ZodError } from 'zod'
import { isProduction } from '../config/env.js'
import { DatabaseNotConfiguredError } from '../db/client.js'
import { ApiError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

/** Anything that fell through the router. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'not_found',
      message: `No route for ${req.method} ${req.path}`,
      requestId: req.requestId,
    },
  })
}

interface NormalisedError {
  status: number
  code: string
  message: string
  details?: unknown
}

/**
 * Turns anything thrown anywhere into the one error envelope the client sees.
 * The rule: known, expected failures keep their message; everything else
 * becomes a bare 500. A Postgres driver error must never reach the browser —
 * it leaks table names, column names and sometimes row values.
 */
function normalise(error: unknown): NormalisedError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
    }
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      code: 'bad_request',
      message: 'Invalid request',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  }

  if (error instanceof DatabaseNotConfiguredError) {
    return {
      status: 503,
      code: 'database_not_configured',
      message:
        'The database is not configured. Set DATABASE_URL and run the migrations — see README.',
    }
  }

  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    return {
      status,
      code: error.code === 'LIMIT_FILE_SIZE' ? 'payload_too_large' : 'bad_request',
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'That file is too large.'
          : `Upload rejected: ${error.message}`,
      details: { field: error.field },
    }
  }

  // Postgres error codes worth translating rather than swallowing.
  const pgCode = (error as { code?: string } | null)?.code
  if (pgCode === '23505') {
    return { status: 409, code: 'conflict', message: 'That record already exists.' }
  }
  if (pgCode === '23503') {
    return { status: 400, code: 'bad_request', message: 'That reference does not exist.' }
  }
  if (pgCode === 'ECONNREFUSED' || pgCode === 'ENOTFOUND') {
    return {
      status: 503,
      code: 'database_unavailable',
      message: 'Cannot reach the database right now.',
    }
  }

  return { status: 500, code: 'internal_error', message: 'Something went wrong on our end.' }
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (res.headersSent) return next(error)

  const normalised = normalise(error)

  const logPayload = {
    err: error,
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    userId: req.user?.id,
    status: normalised.status,
  }

  if (normalised.status >= 500) logger.error(logPayload, normalised.message)
  else logger.warn(logPayload, normalised.message)

  res.status(normalised.status).json({
    error: {
      code: normalised.code,
      message: normalised.message,
      ...(normalised.details ? { details: normalised.details } : {}),
      requestId: req.requestId,
      // Stacks in development only. Never in production.
      ...(!isProduction && normalised.status >= 500 && error instanceof Error
        ? { stack: error.stack }
        : {}),
    },
  })
}
