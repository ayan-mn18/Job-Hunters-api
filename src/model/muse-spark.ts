import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { assertWithinBudget, recordUsage, type Purpose } from './meter.js'

/**
 * Muse Spark, through Meta's Model API.
 *
 * This sits beside `ModelGateway` rather than inside it because the two speak
 * different wire protocols: the gateway is built on Anthropic's SDK, and Meta's
 * Model API is OpenAI-compatible. The gateway calls into here for every purpose
 * once `MODEL_PROVIDER=muse`, which is the default. What the two share is the
 * part that matters — every call is metered into `model_usage` and checked
 * against the same monthly budget, so a second provider does not create a
 * second, unwatched bill.
 *
 * It is a reasoning model, and the reasoning is where the budget goes: a
 * one-word reply measured 434 reasoning tokens against 12 prompt tokens. Give
 * `maxTokens` real headroom or responses come back with `finish_reason:
 * "length"` and a null message, which reads as an empty answer rather than a
 * truncated one.
 */

export interface MuseMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  tool_call_id?: string
  tool_calls?: unknown
}

export interface MuseToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface MuseResult {
  content: string | null
  toolCalls: MuseToolCall[]
  finishReason: string
}

interface MuseResponse {
  choices?: Array<{
    finish_reason?: string
    message?: { content?: string | null; tool_calls?: MuseToolCall[] }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string }
}

export class MuseSparkUnavailableError extends Error {
  constructor() {
    super('META_API_KEY is not set — Muse Spark is unreachable, so every model-backed feature is disabled.')
    this.name = 'MuseSparkUnavailableError'
  }
}

export async function museSpark(params: {
  userId: string | null
  messages: MuseMessage[]
  tools?: unknown[]
  /** OpenAI-style `response_format`, for schema-constrained answers. */
  responseFormat?: unknown
  maxTokens?: number
  temperature?: number
  /** What this call was for. Meters against the same purposes as Anthropic. */
  purpose?: Purpose
  /** Defaults to the browser agent's model; the gateway passes its own. */
  model?: string
}): Promise<MuseResult> {
  if (!env.META_API_KEY) throw new MuseSparkUnavailableError()
  await assertWithinBudget(params.userId)

  const purpose: Purpose = params.purpose ?? 'apply-agent'
  const model = params.model ?? env.APPLY_AGENT_MODEL
  const startedAt = Date.now()

  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
    max_tokens: params.maxTokens ?? env.APPLY_AGENT_MAX_TOKENS,
  }
  if (params.tools?.length) body.tools = params.tools
  if (params.responseFormat) body.response_format = params.responseFormat
  if (params.temperature !== undefined) body.temperature = params.temperature

  try {
    const response = await fetch(`${env.META_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.META_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })

    const json = (await response.json()) as MuseResponse
    if (!response.ok) {
      throw new Error(`Meta Model API ${response.status}: ${json.error?.message ?? 'unknown error'}`)
    }

    const choice = json.choices?.[0]
    // Meta reports reasoning inside `completion_tokens`, so the usage shape
    // below maps cleanly onto the gateway's Anthropic-shaped meter.
    await recordUsage({
      userId: params.userId,
      purpose,
      model,
      usage: {
        input_tokens: json.usage?.prompt_tokens ?? 0,
        output_tokens: json.usage?.completion_tokens ?? 0,
        cache_read_input_tokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      durationMs: Date.now() - startedAt,
      ok: true,
    })

    const finishReason = choice?.finish_reason ?? 'unknown'
    if (finishReason === 'length' && !choice?.message?.content) {
      logger.warn(
        { model, maxTokens: body.max_tokens },
        'Muse Spark spent its whole budget reasoning and returned nothing — raise APPLY_AGENT_MAX_TOKENS',
      )
    }

    return {
      content: choice?.message?.content ?? null,
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason,
    }
  } catch (error) {
    await recordUsage({
      userId: params.userId,
      purpose,
      model,
      usage: undefined,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
