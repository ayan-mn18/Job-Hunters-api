import { Router } from 'express'
import { badRequest } from '../../lib/errors.js'
import { asyncHandler, ok } from '../../lib/http.js'
import { currentUser, requireAuth } from '../../middleware/auth.js'
import { createDodoCheckout, dodoStatus, unwrapDodoWebhook } from './dodo.js'
import { logger } from '../../lib/logger.js'

export const billingRouter: Router = Router()

billingRouter.get(
  '/status',
  requireAuth,
  asyncHandler(async (_req, res) => {
    ok(res, dodoStatus())
  }),
)

billingRouter.post(
  '/checkout',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await createDodoCheckout(currentUser(req)))
  }),
)

/**
 * Dodo signs the exact raw JSON body. This route is mounted before the global
 * JSON parser in app.ts, so a parsed-and-reserialised object can never pass as
 * an authentic webhook by accident.
 */
billingRouter.post(
  '/dodo/webhook',
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw badRequest('Dodo webhook body must be JSON.')

    const headers = {
      'webhook-id': req.get('webhook-id') ?? '',
      'webhook-signature': req.get('webhook-signature') ?? '',
      'webhook-timestamp': req.get('webhook-timestamp') ?? '',
    }
    const event = unwrapDodoWebhook(req.body.toString('utf8'), headers) as { type?: string }

    // Payment/subscription entitlements will be persisted when a product plan
    // is chosen. Verification and idempotent acknowledgement are in place now;
    // the disabled default means this endpoint cannot move money.
    logger.info({ type: event.type ?? 'unknown' }, 'Dodo webhook verified')
    ok(res, { received: true })
  }),
)
