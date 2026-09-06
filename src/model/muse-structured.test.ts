import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractJson } from './muse-structured.js'

/**
 * Muse Spark honours a json_schema most of the time and wraps the answer in
 * prose or a fence the rest of it. Every case below came off a real response.
 */
describe('extractJson', () => {
  it('passes bare JSON through', () => {
    assert.equal(extractJson('{"a":1}'), '{"a":1}')
  })

  it('unwraps a fenced block', () => {
    assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}')
    assert.equal(extractJson('```\n{"a":1}\n```'), '{"a":1}')
  })

  it('drops prose before and after the object', () => {
    assert.equal(
      extractJson('Here is the result:\n{"a":1}\nLet me know if that helps.'),
      '{"a":1}',
    )
  })

  it('handles a top-level array', () => {
    assert.equal(extractJson('Sure:\n[1,2,3]'), '[1,2,3]')
  })

  it('keeps nested braces intact', () => {
    assert.equal(extractJson('```json\n{"a":{"b":[1]}}\n```'), '{"a":{"b":[1]}}')
  })

  it('returns the text unchanged when there is no JSON in it', () => {
    assert.equal(extractJson('I could not answer that.'), 'I could not answer that.')
  })
})
