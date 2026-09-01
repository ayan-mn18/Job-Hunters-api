import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { and, eq, gte, sql } from 'drizzle-orm'
// The SDK's zod helper targets zod v4. The rest of this codebase validates
// HTTP input with the v3 API, and zod 3.25 ships both under separate entry
// points — so model schemas import `zod/v4` and request schemas stay as they
// are. Mixing is deliberate and confined to this directory.
import type { z } from 'zod/v4'
import { env, hasModelAccess } from '../config/env.js'
import { db } from '../db/client.js'
import { modelUsage } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { costUsd } from './pricing.js'

/**
 * Every model call in the product goes through here.
 *
 * Two reasons it is a chokepoint rather than a convenience wrapper. First,
 * metering: a flat monthly price only works if the variable cost underneath it
 * is visible, and cost accounting bolted on after pricing is set is how a flat
 * fee quietly stops covering itself. Second, portability: the open-source
 * split wants a bring-your-own-key mode, and one seam makes that a config
 * change instead of a refactor.
 *
 * Callers never construct an Anthropic client themselves.
 */

export type Purpose =
  | 'rerank'
  | 'classify-email'
  | 'classify-referral'
  | 'map-field'
  | 'draft-referral'
  | 'draft-outreach'
  | 'parse-persona'

export class ModelUnavailableError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not set — model-backed features are disabled.')
    this.name = 'ModelUnavailableError'
  }
}

export class ModelBudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(`Monthly model budget reached: $${spent.toFixed(2)} of $${budget.toFixed(2)}.`)
    this.name = 'ModelBudgetExceededError'
  }
}

export interface CallOptions {
  purpose: Purpose
  /** Null for platform-level work not attributable to one user. */
  userId: string | null
  system?: string
  prompt: string
  maxTokens?: number
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Adaptive thinking is on by default; turn it off for cheap classification. */
  think?: boolean
}

export function modelFor(purpose: Purpose): string {
  switch (purpose) {
    case 'rerank':
      return env.MODEL_RERANK ?? env.MODEL_DEFAULT
    case 'classify-email':
    case 'classify-referral':
    case 'map-field':
      return env.MODEL_CLASSIFY ?? env.MODEL_DEFAULT
    case 'draft-referral':
    case 'draft-outreach':
      return env.MODEL_DRAFT ?? env.MODEL_DEFAULT
    default:
      return env.MODEL_DEFAULT
  }
}

let client: Anthropic | undefined

function anthropic(): Anthropic {
  if (!hasModelAccess) throw new ModelUnavailableError()
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  return client
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

async function assertWithinBudget(userId: string | null): Promise<void> {
  if (!userId || env.MODEL_MONTHLY_BUDGET_USD <= 0) return
  const spent = await monthlySpendUsd(userId)
  if (spent >= env.MODEL_MONTHLY_BUDGET_USD) {
    throw new ModelBudgetExceededError(spent, env.MODEL_MONTHLY_BUDGET_USD)
  }
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
}

async function record(params: {
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

/**
 * A call that must come back as the given shape.
 *
 * Structured output is the default here rather than an option: every consumer
 * in this codebase wants a typed object, and free-text-then-parse is where
 * that goes wrong at three in the morning.
 */
export async function structured<T extends z.ZodType>(
  schema: T,
  options: CallOptions,
): Promise<z.infer<T>> {
  const model = modelFor(options.purpose)
  await assertWithinBudget(options.userId)

  const startedAt = Date.now()
  try {
    const response = await anthropic().messages.parse({
      model,
      max_tokens: options.maxTokens ?? 16_000,
      ...(options.system ? { system: options.system } : {}),
      ...(options.think === false ? {} : { thinking: { type: 'adaptive' as const } }),
      output_config: {
        format: zodOutputFormat(schema),
        ...(options.effort ? { effort: options.effort } : {}),
      },
      messages: [{ role: 'user', content: options.prompt }],
    })

    await record({
      userId: options.userId,
      purpose: options.purpose,
      model,
      usage: response.usage,
      durationMs: Date.now() - startedAt,
      ok: true,
    })

    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new Error('Model returned no parsable output for the requested schema.')
    }
    return response.parsed_output as z.infer<T>
  } catch (error) {
    await record({
      userId: options.userId,
      purpose: options.purpose,
      model,
      usage: undefined,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/** A call whose answer is prose — drafts, summaries. Streamed, so long
 *  outputs cannot trip the SDK's request timeout. */
export async function text(options: CallOptions): Promise<string> {
  const model = modelFor(options.purpose)
  await assertWithinBudget(options.userId)

  const startedAt = Date.now()
  try {
    const stream = anthropic().messages.stream({
      model,
      max_tokens: options.maxTokens ?? 8_000,
      ...(options.system ? { system: options.system } : {}),
      ...(options.think === false ? {} : { thinking: { type: 'adaptive' as const } }),
      ...(options.effort ? { output_config: { effort: options.effort } } : {}),
      messages: [{ role: 'user', content: options.prompt }],
    })
    const message = await stream.finalMessage()

    await record({
      userId: options.userId,
      purpose: options.purpose,
      model,
      usage: message.usage,
      durationMs: Date.now() - startedAt,
      ok: true,
    })

    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()
  } catch (error) {
    await record({
      userId: options.userId,
      purpose: options.purpose,
      model,
      usage: undefined,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export const modelGateway = { structured, text, monthlySpendUsd, modelFor }
