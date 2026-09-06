import DodoPayments from 'dodopayments'
import { env, hasDodoPayments } from '../../config/env.js'
import { serviceUnavailable } from '../../lib/errors.js'
import type { AuthenticatedUser } from '../../middleware/auth.js'

export function dodoStatus() {
  return {
    provider: 'dodo' as const,
    enabled: env.DODO_PAYMENTS_ENABLED,
    testMode: env.DODO_PAYMENTS_BASE_URL.includes('test.'),
    checkoutReady: hasDodoPayments,
    webhookReady: Boolean(env.DODO_PAYMENTS_ENABLED && env.DODO_PAYMENTS_WEBHOOK_KEY),
  }
}

function dodoClient(): DodoPayments {
  if (!env.DODO_PAYMENTS_API_KEY) {
    throw serviceUnavailable('Dodo Payments is not configured.')
  }
  return new DodoPayments({
    bearerToken: env.DODO_PAYMENTS_API_KEY,
    baseURL: env.DODO_PAYMENTS_BASE_URL,
    webhookKey: env.DODO_PAYMENTS_WEBHOOK_KEY ?? null,
  })
}

export async function createDodoCheckout(user: AuthenticatedUser) {
  if (!env.DODO_PAYMENTS_ENABLED) {
    throw serviceUnavailable('Dodo Payments is configured but still disabled.')
  }
  if (!env.DODO_PAYMENTS_PRODUCT_ID || !hasDodoPayments) {
    throw serviceUnavailable('Dodo Payments needs a product ID before checkout can be enabled.')
  }

  const checkout = await dodoClient().checkoutSessions.create({
    product_cart: [{ product_id: env.DODO_PAYMENTS_PRODUCT_ID, quantity: 1 }],
    customer: { email: user.email, name: user.name },
    ...(env.DODO_PAYMENTS_RETURN_URL ? { return_url: env.DODO_PAYMENTS_RETURN_URL } : {}),
    metadata: { user_id: user.id },
  })

  if (!checkout.checkout_url) {
    throw serviceUnavailable('Dodo Payments did not return a checkout URL.')
  }
  return { sessionId: checkout.session_id, checkoutUrl: checkout.checkout_url }
}

export function unwrapDodoWebhook(rawBody: string, headers: Record<string, string>) {
  if (!env.DODO_PAYMENTS_ENABLED) {
    throw serviceUnavailable('Dodo Payments webhooks are still disabled.')
  }
  if (!env.DODO_PAYMENTS_WEBHOOK_KEY) {
    throw serviceUnavailable('Dodo Payments webhook verification is not configured.')
  }
  return dodoClient().webhooks.unwrap(rawBody, { headers })
}
