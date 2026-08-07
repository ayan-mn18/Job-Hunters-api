/**
 * One error class for everything the client is allowed to see. Anything thrown
 * that is *not* an ApiError is treated as a bug and reported as a bare 500 with
 * no detail — stack traces and driver messages never reach the browser.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown
  readonly expose: boolean

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.expose = status < 500
    Error.captureStackTrace?.(this, ApiError)
  }
}

export const badRequest = (message = 'Bad request', details?: unknown) =>
  new ApiError(400, 'bad_request', message, details)

export const unauthorized = (message = 'Not authenticated', details?: unknown) =>
  new ApiError(401, 'unauthorized', message, details)

export const forbidden = (message = 'Not allowed', details?: unknown) =>
  new ApiError(403, 'forbidden', message, details)

export const notFound = (message = 'Not found', details?: unknown) =>
  new ApiError(404, 'not_found', message, details)

export const conflict = (message = 'Conflict', details?: unknown) =>
  new ApiError(409, 'conflict', message, details)

export const unprocessable = (message = 'Unprocessable', details?: unknown) =>
  new ApiError(422, 'unprocessable_entity', message, details)

export const tooLarge = (message = 'Payload too large', details?: unknown) =>
  new ApiError(413, 'payload_too_large', message, details)

export const tooManyRequests = (message = 'Too many requests', details?: unknown) =>
  new ApiError(429, 'too_many_requests', message, details)

export const serviceUnavailable = (message = 'Service unavailable', details?: unknown) =>
  new ApiError(503, 'service_unavailable', message, details)

export const notImplemented = (message = 'Not implemented yet', details?: unknown) =>
  new ApiError(501, 'not_implemented', message, details)
