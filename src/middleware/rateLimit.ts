import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit'
import { env, isTest } from '../config/env.js'

/**
 * In-memory limiter. Correct for a single process, which is what this is
 * today. The moment the API runs more than one instance this needs a shared
 * store (`rate-limit-redis` against the same Redis the BullMQ workstream is
 * standing up) or each instance will independently allow the full quota.
 */

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Tests would otherwise trip the limiter and fail for the wrong reason.
  skip: () => isTest,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: 'too_many_requests',
        message: 'Too many attempts. Wait a little and try again.',
      },
    })
  },
}

/**
 * Login and signup. Keyed on IP *and* the submitted email, so one attacker
 * cannot lock every user out by hammering a shared NAT address, and spraying
 * one password across many accounts still gets caught.
 */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => {
    const ip = ipKeyGenerator(req.ip ?? '0.0.0.0')
    const email =
      typeof (req.body as { email?: unknown } | undefined)?.email === 'string'
        ? (req.body as { email: string }).email.toLowerCase()
        : ''
    return email ? `${ip}:${email}` : ip
  },
})

/** Refresh is called on a timer by every open tab, so it gets more headroom. */
export const refreshLimiter = rateLimit({
  ...shared,
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX * 5,
})

/** Blanket ceiling on everything else — a backstop, not a business rule. */
export const globalLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 300,
})

/** Generation is the expensive path once a real model is wired in. */
export const generationLimiter = rateLimit({
  ...shared,
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? '0.0.0.0'),
})
