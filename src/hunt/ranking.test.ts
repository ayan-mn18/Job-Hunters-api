import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { rankJob } from './ranking.js'
import type { ScrapedJob } from './discovery/types.js'

function job(overrides: Partial<ScrapedJob> = {}): ScrapedJob {
  return {
    sourceId: '1',
    portal: 'greenhouse',
    url: 'https://example.test/jobs/1',
    title: 'Senior TypeScript Engineer',
    company: 'Careem',
    locations: [{ raw: 'Dubai, United Arab Emirates', city: 'Dubai', countryCode: 'AE', isRemote: false }],
    remote: 'onsite',
    descriptionText: 'Build TypeScript, React and Node.js services.',
    tags: [],
    postedAt: '2026-08-08T00:00:00.000Z',
    postedAtPrecision: 'exact',
    fetchedAt: '2026-08-08T01:00:00.000Z',
    fingerprint: 'fingerprint',
    ...overrides,
  }
}

const profile = {
  roles: ['Senior TypeScript Engineer'],
  locations: ['Dubai', 'Remote'],
  dreamCompanies: ['Careem'],
  dealBreakers: ['unpaid'],
  skills: ['TypeScript', 'React', 'Node.js'],
  minMatchScore: 70,
}

describe('job ranking', () => {
  it('accepts strong role, skill, location and company matches', () => {
    const result = rankJob(job(), profile)
    assert.equal(result.accepted, true)
    assert.ok(result.score >= 70)
    assert.equal(result.breakdown.company, 10)
  })

  it('rejects explicit deal breakers regardless of score', () => {
    const result = rankJob(job({ descriptionText: 'Unpaid position using TypeScript and React.' }), profile)
    assert.equal(result.accepted, false)
    assert.equal(result.score, 0)
    assert.match(result.reasons[0] ?? '', /Deal breaker/)
  })

  it('does not treat country-restricted remote work as worldwide', () => {
    const result = rankJob(job({
      company: 'Example',
      locations: [{ raw: 'Remote, United States', countryCode: 'US', isRemote: true }],
      remote: 'remote',
    }), { ...profile, dreamCompanies: [] })
    assert.equal(result.breakdown.location, 5)
    assert.match(result.reasons.join(' '), /country-restricted/)
  })
})
