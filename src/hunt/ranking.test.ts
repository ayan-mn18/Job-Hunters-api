import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_WEIGHTS, rankJob, readWeights, requiredSkillsOf, type RankableJob } from './ranking.js'

/** The real profile this is tuned for: backend Java + full-stack TypeScript. */
const profile = {
  roles: ['Sr. SWE', 'Senior Software Engineer', 'Full Stack Engineer'],
  locations: ['Remote', 'Bengaluru', 'Dubai'],
  dreamCompanies: [],
  dealBreakers: [],
  skills: [
    'Java', 'Spring Boot', 'JavaScript', 'TypeScript', 'React', 'Next.js', 'Node.js',
    'SQL', 'PostgreSQL', 'MongoDB', 'Kafka', 'Redis', 'Docker', 'Kubernetes', 'AWS',
    'REST APIs', 'Microservices', 'Distributed systems', 'CI/CD', 'Jenkins', 'Nginx',
  ],
  maxYearsExperience: 5,
  minMatchScore: 75,
}

function job(overrides: Partial<RankableJob> = {}): RankableJob {
  return {
    title: 'Senior Software Engineer',
    company: 'Acme',
    locations: [{ raw: 'Bengaluru, India', city: 'Bengaluru', countryCode: 'IN', isRemote: false }],
    remote: 'onsite',
    skills: ['Java', 'Spring Boot', 'PostgreSQL', 'Kafka', 'REST APIs'],
    experience: { min: 3, max: null, text: '3+ years' },
    descriptionText: [
      'Requirements',
      '• 3+ years of experience building backend services.',
      '• Strong Java and Spring Boot.',
      '• PostgreSQL, Kafka and REST APIs.',
    ].join('\n'),
    tags: [],
    ...overrides,
  }
}

describe('job ranking', () => {
  it('scores a job built on the candidate stack near the top', () => {
    const result = rankJob(job(), profile)
    assert.equal(result.decision, 'eligible')
    assert.ok(result.score >= 90, `expected >= 90, got ${result.score}`)
    assert.equal(result.missingSkills.length, 0)
  })

  it('rejects non-software roles outright, with no score', () => {
    for (const title of [
      'Technical Program Manager',
      'Product Designer',
      'Freelance Copywriter',
      'Machine Learning Engineer',
      'Senior QA Automation Engineer',
      'Enterprise Account Executive',
    ]) {
      const result = rankJob(job({ title }), profile)
      assert.equal(result.decision, 'role_mismatch', title)
      assert.equal(result.score, 0, title)
      assert.equal(result.accepted, false, title)
    }
  })

  it('measures coverage of what the posting asks for, not raw overlap', () => {
    // Same five of the candidate's skills appear in both, but the second
    // posting asks for far more that the candidate does not have.
    const focused = rankJob(job(), profile)
    const sprawling = rankJob(
      job({
        skills: ['Java', 'Spring Boot', 'PostgreSQL', 'Kafka', 'REST APIs', 'Scala', 'Elixir', 'Haskell', 'Clojure', 'Erlang'],
        descriptionText: [
          'Requirements',
          '• Strong Java, Spring Boot, PostgreSQL, Kafka and REST APIs.',
          '• Also Scala, Elixir, Haskell, Clojure and Erlang in production.',
        ].join('\n'),
      }),
      profile,
    )
    assert.ok(
      sprawling.breakdown.coverage < focused.breakdown.coverage,
      `${sprawling.breakdown.coverage} should be under ${focused.breakdown.coverage}`,
    )
    assert.ok(sprawling.missingSkills.length > 0)
  })

  it('reports which required skills are missing', () => {
    const result = rankJob(
      job({
        skills: ['Python', 'Django', 'PostgreSQL'],
        descriptionText: 'Requirements\n• Strong Python and Django.\n• PostgreSQL in production.',
      }),
      profile,
    )
    assert.ok(result.missingSkills.includes('Python'))
    assert.ok(result.missingSkills.includes('Django'))
    assert.ok(result.matchedSkills.includes('PostgreSQL'))
  })

  it('prefers a backend role over a mobile one with the same coverage', () => {
    const backend = rankJob(job({ title: 'Senior Backend Engineer' }), profile)
    const mobile = rankJob(job({ title: 'Senior Android Engineer' }), profile)
    assert.ok(mobile.score < backend.score)
  })

  it('keeps a remote worldwide role scoring well', () => {
    const result = rankJob(
      job({ locations: [{ raw: 'Remote, Worldwide', isRemote: true }], remote: 'remote' }),
      profile,
    )
    assert.equal(result.decision, 'eligible')
  })

  it('drops a country-restricted remote role below the bar', () => {
    const result = rankJob(
      job({
        locations: [{ raw: 'Remote, United States', countryCode: 'US', isRemote: true }],
        remote: 'remote',
      }),
      profile,
    )
    assert.ok(result.score < 75, `expected under 75, got ${result.score}`)
    assert.equal(result.decision, 'location_mismatch')
  })

  it('penalises experience far above the ceiling', () => {
    const senior = rankJob(job({ experience: { min: 12, max: null, text: '12+ years' } }), profile)
    assert.equal(senior.breakdown.experience, 0)
    assert.ok(senior.score < rankJob(job(), profile).score)
  })

  it('caps how many skills a posting can demand', () => {
    const required = requiredSkillsOf(
      job({
        descriptionText: `Requirements\n${Array.from({ length: 40 }, (_, i) => `• Skill ${i} with Java and React and Python and Go and Rust and Kafka.`).join('\n')}`,
      }),
    )
    assert.ok(required.length <= 12, `got ${required.length}`)
  })

  it('normalises custom weights back to a 100-point scale', () => {
    const weights = readWeights({ coverage: 90, stack: 40, experience: 24, seniority: 16, location: 30 })
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
    assert.ok(Math.abs(total - 100) < 0.001)
    assert.deepEqual(readWeights(null), DEFAULT_WEIGHTS)
    assert.deepEqual(readWeights({ nonsense: true }), DEFAULT_WEIGHTS)
  })
})
