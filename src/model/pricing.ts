/**
 * Published per-million-token rates, used to turn a token count into a number
 * we can put in front of a user.
 *
 * These are Anthropic first-party API rates and they change. The value stored
 * on the `model_usage` row is what this table said at the time of the call, so
 * a later price change does not silently rewrite history — and an unknown
 * model bills as zero rather than guessing, which shows up as a suspiciously
 * free purpose in the cost report instead of a wrong number.
 */

export interface Rate {
  /** USD per million input tokens. */
  input: number
  /** USD per million output tokens. */
  output: number
}

const RATES: Record<string, Rate> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

/** Cache reads bill at roughly a tenth of the normal input rate. */
const CACHE_READ_MULTIPLIER = 0.1

export function rateFor(model: string): Rate | null {
  return RATES[model] ?? null
}

export function costUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
): number {
  const rate = rateFor(model)
  if (!rate) return 0
  const cached = usage.cachedInputTokens ?? 0
  const fresh = Math.max(0, usage.inputTokens - cached)
  const dollars =
    (fresh / 1_000_000) * rate.input +
    (cached / 1_000_000) * rate.input * CACHE_READ_MULTIPLIER +
    (usage.outputTokens / 1_000_000) * rate.output
  // Six decimals matches the column; a single classification can cost less
  // than a thousandth of a cent and rounding it to zero loses the total.
  return Number(dollars.toFixed(6))
}
