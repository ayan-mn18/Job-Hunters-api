import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inferSeniority, inferTargetTitles } from './store.js'

describe('persona seeding', () => {
  it('trusts the title over the arithmetic', () => {
    // Someone with two years who is already called Senior is telling us their
    // level. The date maths would have said "mid".
    const fromTitle = inferSeniority(['Senior Backend Engineer'], 2)
    assert.equal(fromTitle?.value, 'senior')
    assert.ok((fromTitle?.confidence ?? 0) > 0.8)
  })

  it('falls back to years when no title says a level', () => {
    assert.equal(inferSeniority(['Backend Engineer'], 1)?.value, 'junior')
    assert.equal(inferSeniority(['Backend Engineer'], 3)?.value, 'mid')
    assert.equal(inferSeniority(['Backend Engineer'], 7)?.value, 'senior')
    assert.equal(inferSeniority(['Backend Engineer'], 12)?.value, 'staff')
  })

  it('says nothing rather than guessing when it has nothing', () => {
    assert.equal(inferSeniority([], null), null)
  })

  it('recognises the abbreviated forms people actually write', () => {
    assert.equal(inferSeniority(['Sr. Software Engineer'], null)?.value, 'senior')
    assert.equal(inferSeniority(['Jr Developer'], null)?.value, 'junior')
    assert.equal(inferSeniority(['Principal Engineer'], null)?.value, 'staff')
  })

  it('keeps target titles at moderate confidence', () => {
    // What someone did last is a good guess at what they want next, and not
    // the same thing — so the slot stays eligible to be asked about.
    const titles = inferTargetTitles(['Backend Engineer', 'Software Engineer'])
    assert.ok(titles)
    assert.ok(titles.confidence < 0.6, 'must stay below the confident-enough bar')
    assert.deepEqual(titles.value, ['backend engineer', 'software engineer'])
  })

  it('returns nothing for an empty resume', () => {
    assert.equal(inferTargetTitles([]), null)
    assert.equal(inferTargetTitles(['  ']), null)
  })
})
