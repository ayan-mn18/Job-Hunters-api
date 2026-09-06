import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeMissing } from './apply-fields.js'

describe('apply-stage fields', () => {
  it('names one missing field plainly', () => {
    assert.equal(describeMissing(['phone']), 'Phone number')
  })

  it('reads as a sentence when several are missing', () => {
    // This string goes straight into an error the user reads before a run, so
    // it has to be a phrase, not a list of column names.
    assert.equal(
      describeMissing(['fullName', 'email', 'phone']),
      'Full name, Email for applications and Phone number',
    )
  })

  it('falls back to the id rather than rendering undefined', () => {
    assert.equal(describeMissing(['nonsense' as never]), 'nonsense')
  })

  it('returns an empty string for nothing missing', () => {
    assert.equal(describeMissing([]), '')
  })
})
