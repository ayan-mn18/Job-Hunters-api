import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canonicalise, isAtsUrl } from './canonicalise.js'
import type { ScrapedJob } from './types.js'

function job(overrides: Partial<ScrapedJob>): ScrapedJob {
  return {
    sourceId: 'x',
    portal: 'test',
    url: 'https://example.com/job',
    title: 'Backend Engineer',
    company: 'Stripe',
    locations: [],
    remote: 'unknown',
    employmentType: 'full_time',
    responsibilities: [],
    skills: [],
    experience: { min: null, max: null, text: null },
    salary: { min: null, max: null, currency: null, period: null, text: null },
    tags: [],
    postedAt: '2026-08-20T00:00:00.000Z',
    postedAtPrecision: 'exact',
    fetchedAt: '2026-08-20T00:00:00.000Z',
    fingerprint: Math.random().toString(36),
    extractionMeta: {},
    detailFetched: false,
    ...overrides,
  }
}

describe('cross-source canonicalisation', () => {
  it('recognises the ATS hosts we can actually apply through', () => {
    assert.equal(isAtsUrl('https://boards.greenhouse.io/stripe/jobs/1'), true)
    assert.equal(isAtsUrl('https://jobs.lever.co/stripe/abc'), true)
    assert.equal(isAtsUrl('https://in.linkedin.com/jobs/view/123'), false)
    assert.equal(isAtsUrl(null), false)
    assert.equal(isAtsUrl('not a url'), false)
  })

  it('keeps the copy we can apply to, not the longest one', () => {
    // The aggregator's listing is richer, but its URL lands on an
    // interstitial the apply runtime cannot complete.
    const aggregator = job({
      portal: 'google-jobs',
      url: 'https://in.linkedin.com/jobs/view/1',
      descriptionText: 'x'.repeat(5_000),
    })
    const ats = job({
      portal: 'greenhouse',
      url: 'https://boards.greenhouse.io/stripe/jobs/1',
      applyUrl: 'https://boards.greenhouse.io/stripe/jobs/1',
      descriptionText: 'x'.repeat(800),
    })

    const [kept, ...rest] = canonicalise([aggregator, ats])
    assert.equal(rest.length, 0, 'the two copies should collapse into one')
    assert.equal(kept?.portal, 'greenhouse')
  })

  it('treats "Engineer II" and "Engineer 2" as the same role', () => {
    const roman = job({ title: 'Software Engineer II', fingerprint: 'a' })
    const arabic = job({ title: 'Software Engineer 2', fingerprint: 'b' })
    assert.equal(canonicalise([roman, arabic]).length, 1)
  })

  it('ignores company suffixes when matching', () => {
    const plain = job({ company: 'Acme', fingerprint: 'a' })
    const suffixed = job({ company: 'Acme Technologies Pvt Ltd', fingerprint: 'b' })
    assert.equal(canonicalise([plain, suffixed]).length, 1)
  })

  it('keeps genuinely different roles apart', () => {
    const backend = job({ title: 'Backend Engineer', fingerprint: 'a' })
    const frontend = job({ title: 'Frontend Engineer', fingerprint: 'b' })
    assert.equal(canonicalise([backend, frontend]).length, 2)
  })

  it('keeps the same role at different companies apart', () => {
    const stripe = job({ company: 'Stripe', fingerprint: 'a' })
    const razorpay = job({ company: 'Razorpay', fingerprint: 'b' })
    assert.equal(canonicalise([stripe, razorpay]).length, 2)
  })

  it('preserves where else the posting was seen', () => {
    const ats = job({
      url: 'https://boards.greenhouse.io/stripe/jobs/1',
      applyUrl: 'https://boards.greenhouse.io/stripe/jobs/1',
      tags: ['Greenhouse'],
    })
    const viaLinkedIn = job({ url: 'https://in.linkedin.com/jobs/view/1', tags: ['LinkedIn'] })

    const [kept] = canonicalise([ats, viaLinkedIn])
    assert.ok(kept?.tags.includes('LinkedIn'), 'should still show it was on LinkedIn')
    assert.ok(kept?.tags.includes('Greenhouse'))
  })
})
