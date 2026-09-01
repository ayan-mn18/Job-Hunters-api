import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { INTAKE_SLOTS, SLOTS, toStringList } from './slots.js'

describe('slot catalogue', () => {
  it('never puts form-only fields in the intake', () => {
    // These buy no matching accuracy. Asking them during onboarding is most of
    // what made the old wizard feel long; they belong at the first apply.
    const intakeIds = new Set(INTAKE_SLOTS.map((slot) => slot.id))
    for (const id of ['phone', 'notice_period', 'current_ctc', 'expected_ctc', 'work_authorization']) {
      assert.ok(!intakeIds.has(id), `${id} must not be asked during intake`)
    }
  })

  it('keeps the intake short enough to fit under the cap', () => {
    // If there were more intake slots than the cap, the cap would be doing the
    // stopping instead of the impact floor, which is the wrong mechanism.
    assert.ok(INTAKE_SLOTS.length <= 7)
  })

  it('gives every slot a question', () => {
    for (const slot of SLOTS) {
      assert.ok(slot.question.prompt.length > 0, `${slot.id} has no prompt`)
    }
  })
})

describe('free-text coercion', () => {
  it('splits a typed line into deal breakers', () => {
    // Forgetting this crashed ranking with `dealBreakers.map is not a
    // function` — the free-text slot stores a string, every consumer wants a
    // list.
    assert.deepEqual(toStringList('no php, no on-call'), ['no php', 'no on-call'])
  })

  it('passes a list straight through', () => {
    assert.deepEqual(toStringList(['a', 'b']), ['a', 'b'])
  })

  it('handles newlines and semicolons, which people also type', () => {
    assert.deepEqual(toStringList('agencies\nunpaid; crypto'), ['agencies', 'unpaid', 'crypto'])
  })

  it('returns a list for anything else rather than throwing', () => {
    assert.deepEqual(toStringList(null), [])
    assert.deepEqual(toStringList(undefined), [])
    assert.deepEqual(toStringList(42), [])
    assert.deepEqual(toStringList(''), [])
  })

  it('drops non-strings out of a mixed array', () => {
    assert.deepEqual(toStringList(['a', 3, null, 'b']), ['a', 'b'])
  })
})
