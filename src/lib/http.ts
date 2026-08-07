import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { badRequest } from './errors.js'

/**
 * Express 5 already forwards rejected promises to the error handler, but being
 * explicit costs nothing and keeps the intent readable at every call site.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

/**
 * `req.params` is an index signature, so under `noUncheckedIndexedAccess`
 * every read is `string | undefined` — even for a segment the route could not
 * have matched without. This asserts the obvious once, in one place, instead
 * of scattering `!` through the handlers.
 */
export function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | undefined>)[name]
  if (value === undefined || value === '') {
    throw badRequest(`Missing path parameter: ${name}`)
  }
  return value
}

/** Every successful response has the same envelope: `{ data, meta? }`. */
export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  res.status(200).json(meta ? { data, meta } : { data })
}

export function created<T>(res: Response, data: T): void {
  res.status(201).json({ data })
}

export function noContent(res: Response): void {
  res.status(204).end()
}
