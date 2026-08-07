import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { z, type ZodTypeAny } from 'zod'
import { badRequest } from '../lib/errors.js'

/**
 * Zod at the edge. Handlers below this line can assume their input is the
 * shape they asked for, which is the entire point — no defensive `?? ''`
 * scattered through the business logic.
 *
 * Parsed output replaces the raw value on the request, so coercions
 * (`"70"` → `70`) and defaults survive into the handler.
 */

export interface ValidationSchemas {
  body?: ZodTypeAny
  query?: ZodTypeAny
  params?: ZodTypeAny
}

function formatIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }))
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) {
        const result = schemas.params.safeParse(req.params)
        if (!result.success) {
          return next(badRequest('Invalid path parameters', formatIssues(result.error)))
        }
        Object.assign(req.params, result.data)
      }

      if (schemas.query) {
        const result = schemas.query.safeParse(req.query)
        if (!result.success) {
          return next(badRequest('Invalid query parameters', formatIssues(result.error)))
        }
        // Express 5 makes req.query a getter-only property, so it is stashed
        // rather than assigned. Handlers read it via `validatedQuery(req)`.
        ;(req as Request & { validatedQuery?: unknown }).validatedQuery = result.data
      }

      if (schemas.body) {
        const result = schemas.body.safeParse(req.body)
        if (!result.success) {
          return next(badRequest('Invalid request body', formatIssues(result.error)))
        }
        req.body = result.data
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Reads what `validate({ query })` stashed. Falls back to the raw query.
 * Typed structurally rather than as `Request` so it accepts a handler whose
 * request generics have been narrowed.
 */
export function validatedQuery<T>(req: { query: unknown }): T {
  const stashed = (req as { validatedQuery?: unknown }).validatedQuery
  return (stashed ?? req.query) as T
}
