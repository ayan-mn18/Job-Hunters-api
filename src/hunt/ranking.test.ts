import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractRequiredExperienceYears, rankJob } from './ranking.js'
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
  roles: ['Senior Software Engineer', 'Senior Frontend Engineer', 'Senior Backend Engineer'],
  locations: ['Dubai', 'Remote'],
  dreamCompanies: ['Careem'],
  dealBreakers: ['unpaid'],
  skills: ['TypeScript', 'React', 'Node.js', 'Java', 'PostgreSQL'],
  maxYearsExperience: 5,
  minMatchScore: 70,
}

describe('job ranking', () => {
  it('accepts strong senior software engineering matches', () => {
    const result = rankJob(job(), profile)
    assert.equal(result.accepted, true)
    assert.equal(result.decision, 'eligible')
    assert.ok(result.score >= 70)
    assert.equal(result.breakdown.company, 5)
    assert.deepEqual(result.matchedSkills, ['TypeScript', 'React', 'Node.js'])
  })

  it('rejects explicit deal breakers regardless of score', () => {
    const result = rankJob(job({ descriptionText: 'Unpaid position using TypeScript and React.' }), profile)
    assert.equal(result.accepted, false)
    assert.equal(result.score, 0)
    assert.match(result.reasons[0] ?? '', /Deal breaker/)
  })

  it('rejects country-restricted remote roles', () => {
    const result = rankJob(job({
      company: 'Example',
      locations: [{ raw: 'Remote, United States', countryCode: 'US', isRemote: true }],
      remote: 'remote',
    }), { ...profile, dreamCompanies: [] })
    assert.equal(result.accepted, false)
    assert.equal(result.decision, 'location_mismatch')
    assert.match(result.reasons.join(' '), /restricted/)
  })

  it('rejects QA despite matching technologies', () => {
    const result = rankJob(job({ title: 'Senior QA Automation Engineer' }), profile)
    assert.equal(result.decision, 'role_mismatch')
    assert.match(result.reasons[0] ?? '', /testing or QA/)
  })

  it('rejects software engineers in test', () => {
    const result = rankJob(job({ title: 'Senior Software Development Engineer in Test' }), profile)
    assert.equal(result.decision, 'role_mismatch')
  })

  it('rejects product management roles', () => {
    const result = rankJob(job({ title: 'Senior Product Manager, Developer Platform' }), profile)
    assert.equal(result.decision, 'role_mismatch')
  })

  it('rejects principal, staff, and lead roles', () => {
    for (const title of ['Principal Software Engineer', 'Staff Backend Engineer', 'Lead Frontend Engineer']) {
      const result = rankJob(job({ title }), profile)
      assert.equal(result.decision, 'role_mismatch')
      assert.match(result.reasons[0] ?? '', /principal, staff, or lead/)
    }
  })

  it('rejects jobs requiring over five years', () => {
    const result = rankJob(job({
      descriptionText: 'Requires 7+ years of experience building TypeScript, React and Node.js services.',
    }), profile)
    assert.equal(result.decision, 'experience_mismatch')
    assert.match(result.reasons[0] ?? '', /Requires 7 years/)
  })

  it('accepts experience requirements up to five years', () => {
    const result = rankJob(job({
      descriptionText: 'Requires 5+ years of experience building TypeScript, React and Node.js services.',
    }), profile)
    assert.equal(result.decision, 'eligible')
  })

  it('extracts minimum years from ranges', () => {
    assert.equal(extractRequiredExperienceYears('Need 3-5 years of professional experience.'), 3)
    assert.equal(extractRequiredExperienceYears('Experience: 8 years.'), 8)
  })

  it('rejects working student software roles', () => {
    const result = rankJob(job({ title: 'Working Student Software Engineer' }), profile)
    assert.equal(result.decision, 'role_mismatch')
  })

  it('rejects roles lacking senior seniority', () => {
    const result = rankJob(job({ title: 'Software Engineer' }), profile)
    assert.equal(result.decision, 'seniority_mismatch')
  })

  it('requires at least three confirmed skills', () => {
    const result = rankJob(job({
      title: 'Senior Backend Engineer',
      descriptionText: 'Build services using Java and PostgreSQL.',
    }), profile)
    assert.equal(result.decision, 'insufficient_skills')
    assert.equal(result.matchedSkills.length, 2)
  })
})
