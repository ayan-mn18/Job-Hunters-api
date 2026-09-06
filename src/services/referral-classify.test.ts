import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bucketFor, mightBeReferralRequest, type ReferralClassification } from './referral-classify.js'

function classification(overrides: Partial<ReferralClassification> = {}): ReferralClassification {
  return {
    verdict: 'request',
    confidence: 0.9,
    targetRole: null,
    company: null,
    requisitionId: null,
    relationship: null,
    urgency: null,
    summary: '',
    ...overrides,
  }
}

describe('referral prefilter', () => {
  it('catches the direct asks', () => {
    for (const text of [
      'Can you refer me for the backend role?',
      'Would you be able to refer me please',
      'Looking for a referral at your company',
      'could you put in a good word for me',
      'Would you vouch for me?',
    ]) {
      assert.ok(mightBeReferralRequest(text), `should look at: ${text}`)
    }
  })

  it('catches the polite phrasings the original four patterns missed', () => {
    // The old regexes needed "refer" next to a request, so these were dropped
    // silently — which is the expensive kind of miss.
    for (const text of [
      'I applied to the Senior Backend position at your company last week',
      'I saw an opening on your team and wondered if you could help',
      'Job ID 48210 — I have applied and would love your support',
    ]) {
      assert.ok(mightBeReferralRequest(text), `should look at: ${text}`)
    }
  })

  it('is loose on purpose, and lets through things that are not requests', () => {
    // The prefilter decides what to *look at*. Precision is the classifier's
    // job, so a false positive here costs one classification.
    assert.ok(mightBeReferralRequest('Thanks for the referral last year!'))
  })

  it('ignores ordinary conversation', () => {
    for (const text of [
      'Congratulations on the new role!',
      'Are you going to the meetup on Thursday?',
      'Happy birthday!',
    ]) {
      assert.equal(mightBeReferralRequest(text), false, `should skip: ${text}`)
    }
  })
})

describe('bucketing', () => {
  it('files a confident request straight into the pile', () => {
    assert.equal(bucketFor(classification({ confidence: 0.9 })), 'referral')
  })

  it('sends a middling verdict to "maybe" rather than dropping it', () => {
    // Dropping a real referral request costs far more than one extra card.
    assert.equal(bucketFor(classification({ confidence: 0.55 })), 'maybe')
    assert.equal(bucketFor(classification({ verdict: 'unclear', confidence: 0.6 })), 'maybe')
  })

  it('ignores a clear non-request whatever its confidence', () => {
    assert.equal(bucketFor(classification({ verdict: 'not_request', confidence: 0.99 })), 'ignored')
  })

  it('ignores anything the model was barely sure of', () => {
    assert.equal(bucketFor(classification({ verdict: 'unclear', confidence: 0.1 })), 'ignored')
  })
})
