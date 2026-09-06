import { and, eq, gte, sql } from 'drizzle-orm'
import { env } from '../config/env.js'
import { db } from '../db/client.js'
import { modelUsage } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { costUsd } from './pricing.js'

/**
 * The meter, and the budget it enforces.
 *
 * Split out of `gateway.ts` because both providers need it and one of them —
 * Muse Spark — is what the gateway now calls into. Leaving these here rather
 * than in the gateway keeps that from becoming an import cycle.
 *
 * The rule this file exists to hold: no model call happens anywhere in the
 * product without landing a row in `model_usage`. A flat price only works if
 * the variable cost under it is visible, and cost accounting added after
 * pricing is set is how a flat fee quietly stops covering itself.
 */

export type Purpose =
  | 'rerank'
  | 'classify-email'
  | 'classify-referral'
  | 'map-field'
  | 'draft-referral'
  | 'draft-outreach'
  | 'parse-persona'
  | 'apply-agent'

export class ModelBudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(`Monthly model budget reached: $${spent.toFixed(2)} of $${budget.toFixed(2)}.`)
    this.name = 'ModelBudgetExceededError'
  }
}

/** What this user has spent on models since the start of the current month. */
export async function monthlySpendUsd(userId: string): Promise<number> {
  const startOfMonth = new Date()
  startOfMonth.setUTCDate(1)
  startOfMonth.setUTCHours(0, 0, 0, 0)

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${modelUsage.usd}), 0)` })
    .from(modelUsage)
    .where(and(eq(modelUsage.userId, userId), gte(modelUsage.createdAt, startOfMonth)))
  return Number(row?.total ?? 0)
}

export async function assertWithinBudget(userId: string | null): Promise<void> {
  if (!userId || env.MODEL_MONTHLY_BUDGET_USD <= 0) return
  const spent = await monthlySpendUsd(userId)
  if (spent >= env.MODEL_MONTHLY_BUDGET_USD) {
    throw new ModelBudgetExceededError(spent, env.MODEL_MONTHLY_BUDGET_USD)
  }
}

export interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
}

export async function recordUsage(params: {
  userId: string | null
  purpose: Purpose
  model: string
  usage: RawUsage | undefined
  durationMs: number
  ok: boolean
  error?: string
}): Promise<void> {
  const inputTokens = params.usage?.input_tokens ?? 0
  const outputTokens = params.usage?.output_tokens ?? 0
  const cachedInputTokens = params.usage?.cache_read_input_tokens ?? 0

  try {
    await db.insert(modelUsage).values({
      userId: params.userId,
      purpose: params.purpose,
      model: params.model,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      usd: String(costUsd(params.model, { inputTokens, outputTokens, cachedInputTokens })),
      durationMs: params.durationMs,
      ok: params.ok,
      error: params.error ?? null,
    })
  } catch (error) {
    // A metering write must never fail the work it was measuring.
    logger.error({ err: error, purpose: params.purpose }, 'could not record model usage')
  }
}
