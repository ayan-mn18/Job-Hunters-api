import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
// The SDK's zod helper targets zod v4. The rest of this codebase validates
// HTTP input with the v3 API, and zod 3.25 ships both under separate entry
// points — so model schemas import `zod/v4` and request schemas stay as they
// are. Mixing is deliberate and confined to this directory.
import type { z } from 'zod/v4'
import { env, hasModelAccess } from '../config/env.js'
import { assertWithinBudget, monthlySpendUsd, recordUsage, type Purpose } from './meter.js'
import { museStructured, museText } from './muse-structured.js'

/**
 * Every model call in the product goes through here.
 *
 * Two reasons it is a chokepoint rather than a convenience wrapper. First,
 * metering: a flat monthly price only works if the variable cost underneath it
 * is visible. Second, portability — and portability stopped being theoretical
 * the day Muse Spark became the default brain. `MODEL_PROVIDER` switches every
 * purpose in the product between two providers that share nothing but this
 * file's two functions, and no caller changed to make that happen.
 *
 * Callers never construct a provider client themselves.
 */

export { ModelBudgetExceededError, monthlySpendUsd } from './meter.js'
export type { Purpose } from './meter.js'

export class ModelUnavailableError extends Error {
  constructor() {
    super(
      env.MODEL_PROVIDER === 'muse'
        ? 'META_API_KEY is not set — model-backed features are disabled.'
        : 'ANTHROPIC_API_KEY is not set — model-backed features are disabled.',
    )
    this.name = 'ModelUnavailableError'
  }
}

export interface CallOptions {
  purpose: Purpose
  /** Null for platform-level work not attributable to one user. */
  userId: string | null
  system?: string
  prompt: string
  maxTokens?: number
  /** Anthropic-only. Muse Spark decides its own reasoning depth. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Adaptive thinking is on by default; turn it off for cheap classification. */
  think?: boolean
}

/**
 * Which model answers a purpose.
 *
 * The per-purpose overrides are provider-agnostic on purpose: setting
 * `MODEL_CLASSIFY` names a model, and naming a model is a stronger statement
 * than naming a provider. Without one, each provider falls back to its own
 * default.
 */
export function modelFor(purpose: Purpose): string {
  const override = (() => {
    switch (purpose) {
      case 'rerank':
        return env.MODEL_RERANK
      case 'classify-email':
      case 'classify-referral':
      case 'map-field':
        return env.MODEL_CLASSIFY
      case 'draft-referral':
      case 'draft-outreach':
        return env.MODEL_DRAFT
      default:
        return undefined
    }
  })()
  if (override) return override
  return env.MODEL_PROVIDER === 'muse' ? env.MUSE_MODEL : env.MODEL_DEFAULT
}

let client: Anthropic | undefined

function anthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new ModelUnavailableError()
  client ??= new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_WORKSPACE_ID
      ? { defaultHeaders: { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } }
      : {}),
  })
  return client
}

export { assertWithinBudget, recordUsage }

/* ----------------------------------------------------------------- anthropic */

async function anthropicStructured<T extends z.ZodType>(
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

    await recordUsage({
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
    await recordUsage({
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

/** Streamed, so a long answer cannot trip the SDK's request timeout. */
async function anthropicText(options: CallOptions): Promise<string> {
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

    await recordUsage({
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
    await recordUsage({
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

/* ------------------------------------------------------------------- public */

/**
 * A call that must come back as the given shape.
 *
 * Structured output is the default here rather than an option: every consumer
 * in this codebase wants a typed object, and free-text-then-parse is where
 * that goes wrong at three in the morning. Both providers validate against the
 * caller's zod schema before returning, so a provider switch cannot change
 * what a caller receives.
 */
export async function structured<T extends z.ZodType>(
  schema: T,
  options: CallOptions,
): Promise<z.infer<T>> {
  if (!hasModelAccess) throw new ModelUnavailableError()
  return env.MODEL_PROVIDER === 'muse'
    ? museStructured(schema, { ...options, model: modelFor(options.purpose) })
    : anthropicStructured(schema, options)
}

/** A call whose answer is prose — drafts, summaries. */
export async function text(options: CallOptions): Promise<string> {
  if (!hasModelAccess) throw new ModelUnavailableError()
  return env.MODEL_PROVIDER === 'muse'
    ? museText({ ...options, model: modelFor(options.purpose) })
    : anthropicText(options)
}

export const modelGateway = { structured, text, monthlySpendUsd, modelFor }
