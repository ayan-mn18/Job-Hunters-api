import type { z } from 'zod/v4'
import { env } from '../config/env.js'
import { museSpark } from './muse-spark.js'
import type { CallOptions } from './gateway.js'

/**
 * Getting a typed object out of a reasoning model.
 *
 * Anthropic's SDK parses structured output for us. Meta's OpenAI-compatible
 * API does not: it accepts a `json_schema` response format, honours it most of
 * the time, and occasionally answers with the right JSON wrapped in prose or a
 * fence anyway. So the schema goes out, and what comes back is unwrapped here
 * and then validated by the caller's own zod schema — the schema on the wire
 * is a strong hint, and the schema in this process is the guarantee.
 *
 * The unwrapping logic was written for Stagehand and lived in
 * `hunt/apply/stagehand-llm.ts`. Stagehand is gone; this was the part of it
 * worth keeping.
 */

/** Pulls the JSON out of an answer that may be fenced, prefixed, or both. */
export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? raw).trim()
  const start = candidate.search(/[[{]/)
  if (start < 0) return candidate
  const opener = candidate[start]
  const closer = opener === '{' ? '}' : ']'
  const end = candidate.lastIndexOf(closer)
  return end > start ? candidate.slice(start, end + 1) : candidate.slice(start)
}

/**
 * Muse spends most of its budget thinking, and a `max_tokens` that only covers
 * the answer comes back empty rather than truncated — `finish_reason: length`
 * with a null message. Every ceiling here is the answer plus room to reason.
 */
const MIN_TOKENS = 4_000

export async function museStructured<T extends z.ZodType>(
  schema: T,
  options: CallOptions & { model?: string },
): Promise<z.infer<T>> {
  const zod = await import('zod/v4')
  const jsonSchema = zod.z.toJSONSchema(schema, { io: 'output' })

  const result = await museSpark({
    userId: options.userId,
    purpose: options.purpose,
    model: options.model ?? env.MUSE_MODEL,
    maxTokens: Math.max(options.maxTokens ?? 16_000, MIN_TOKENS),
    messages: [
      ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
      { role: 'user' as const, content: options.prompt },
    ],
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: options.purpose.replace(/-/g, '_'),
        schema: jsonSchema,
        // Not strict: strict mode requires every property to be required and
        // rejects the optional fields these schemas legitimately have.
        strict: false,
      },
    },
  })

  if (!result.content) {
    throw new Error(
      result.finishReason === 'length'
        ? 'Muse Spark spent its whole budget reasoning and returned nothing. Raise maxTokens.'
        : 'Muse Spark returned no output for the requested schema.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(result.content))
  } catch {
    throw new Error(`Muse Spark returned unparsable JSON: ${result.content.slice(0, 200)}`)
  }
  return schema.parse(parsed) as z.infer<T>
}

export async function museText(options: CallOptions & { model?: string }): Promise<string> {
  const result = await museSpark({
    userId: options.userId,
    purpose: options.purpose,
    model: options.model ?? env.MUSE_MODEL,
    maxTokens: Math.max(options.maxTokens ?? 8_000, MIN_TOKENS),
    messages: [
      ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
      { role: 'user' as const, content: options.prompt },
    ],
  })
  return (result.content ?? '').trim()
}
