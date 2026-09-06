import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { costUsd, rateFor } from './pricing.js'

describe('model pricing', () => {
  it('bills input and output at their separate rates', () => {
    // 1M input at $5 + 1M output at $25.
    const cost = costUsd('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    assert.equal(cost, 30)
  })

  it('bills cached input at a tenth of the input rate', () => {
    const uncached = costUsd('claude-opus-5', { inputTokens: 1_000_000, outputTokens: 0 })
    const fullyCached = costUsd('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    })
    assert.equal(uncached, 5)
    assert.equal(fullyCached, 0.5)
  })

  it('keeps precision on calls that cost a fraction of a cent', () => {
    // A single classification. Rounding this to zero would lose the running
    // total across thousands of calls, which is the whole point of metering.
    const cost = costUsd('claude-haiku-4-5', { inputTokens: 1_200, outputTokens: 150 })
    assert.ok(cost > 0, 'a real call must not bill as zero')
    assert.equal(cost, Number(cost.toFixed(6)))
  })

  it('bills an unknown model as zero rather than guessing', () => {
    assert.equal(rateFor('some-future-model'), null)
    assert.equal(costUsd('some-future-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0)
  })

  it('never bills cached tokens twice', () => {
    // cachedInputTokens is a subset of inputTokens, not an addition to it.
    const half = costUsd('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 500_000,
    })
    // 500k fresh at $5/M = 2.50, plus 500k cached at $0.50/M = 0.25.
    assert.equal(half, 2.75)
  })
})
