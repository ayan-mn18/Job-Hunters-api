import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normaliseHttpUrl } from './urls.js'

describe('application URL normalisation', () => {
  it('adds https to a domain-like value', () => {
    assert.equal(normaliseHttpUrl('linkedin.com/in/example'), 'https://linkedin.com/in/example')
  })

  it('extracts the destination from a Markdown link', () => {
    assert.equal(
      normaliseHttpUrl('[https://linked.in](https://linked.in)'),
      'https://linked.in/',
    )
  })

  it('leaves a valid URL intact', () => {
    assert.equal(normaliseHttpUrl('https://example.com/apply?id=42'), 'https://example.com/apply?id=42')
  })

  it('does not turn blank values into a destination', () => {
    assert.equal(normaliseHttpUrl('  '), '')
  })
})
