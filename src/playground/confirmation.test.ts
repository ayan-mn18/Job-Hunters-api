import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { confirmationBody, type ConfirmationInput } from './confirmation.js'

/**
 * This email is the only artifact of a run that outlives it. If it can claim
 * something went in that did not, it is worse than sending nothing.
 */
function input(overrides: Partial<ConfirmationInput> = {}): ConfirmationInput {
  return {
    to: 'ada@example.com',
    run: { id: 'run-1', prompt: 'find me something' },
    job: {
      title: 'Lead, Engineer',
      company: 'Noora Health',
      location: 'Bengaluru, KA, IN',
      url: 'https://www.workatastartup.com/jobs/94543',
    },
    filled: [
      { label: 'Full name', value: '[agent]' },
      { label: 'Email', value: '[agent]' },
    ],
    blocked: [],
    dryRun: false,
    ...overrides,
  }
}

describe('run confirmation', () => {
  it('says what was sent', () => {
    const { subject, text } = confirmationBody(input())
    assert.equal(subject, 'Applied: Lead, Engineer at Noora Health')
    assert.match(text, /Sent: full name, email\./)
    assert.match(text, /has gone in/)
  })

  it('never claims a blocked field was sent', () => {
    const { text } = confirmationBody(
      input({
        blocked: [{ label: 'Expected annual compensation *', why: 'unknown_field' }],
      }),
    )
    assert.match(text, /Left blank: expected annual compensation\./)
    assert.doesNotMatch(text, /Sent:[^\n]*compensation/)
  })

  it('only mentions the never-auto policy when a policy field was refused', () => {
    const withPolicy = confirmationBody(
      input({ blocked: [{ label: 'Visa sponsorship', why: 'sensitive_field' }] }),
    )
    assert.match(withPolicy.text, /never answered on your behalf/)

    // A field the user simply chose to skip is not Huntly refusing anything.
    const withoutPolicy = confirmationBody(
      input({ blocked: [{ label: 'Expected CTC', why: 'unknown_field' }] }),
    )
    assert.doesNotMatch(withoutPolicy.text, /never answered on your behalf/)
  })

  it('does not describe a dry run as an application', () => {
    const { subject, text } = confirmationBody(input({ dryRun: true }))
    assert.match(subject, /^Dry run:/)
    assert.match(text, /stopped before submitting/)
    assert.doesNotMatch(text, /has gone in/)
  })

  it('is honest when nothing was filled at all', () => {
    const { text } = confirmationBody(input({ filled: [] }))
    assert.match(text, /Nothing was filled\./)
  })
})
