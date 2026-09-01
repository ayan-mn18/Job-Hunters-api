import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  authorityScore,
  rankProspects,
  recencyScore,
  scoreProspect,
  worthContacting,
  type Prospect,
} from './rank.js'

function prospect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    profileUrl: 'https://linkedin.com/in/someone',
    name: 'Someone',
    title: 'Backend Engineer',
    degree: 2,
    relationship: 'cold',
    sameFunction: true,
    levelDelta: 0,
    isRecruiter: false,
    sharedSchool: false,
    sharedEmployer: false,
    sharedCity: false,
    skillOverlap: 0,
    mutualConnections: 0,
    monthsAtCompany: 24,
    activeRecently: true,
    openProfile: false,
    ...overrides,
  }
}

describe('who can actually refer you', () => {
  it('ranks one level above highest, not the most senior person available', () => {
    // A VP is approving headcount, not reading your code. The senior engineer
    // on the team is the useful referral.
    const peer = authorityScore(prospect({ levelDelta: 0 }))
    const oneAbove = authorityScore(prospect({ levelDelta: 1 }))
    const farAbove = authorityScore(prospect({ levelDelta: 3 }))

    assert.ok(oneAbove >= peer, 'one level above should be at least as good as a peer')
    assert.ok(farAbove < peer, 'a VP should rank below a peer')
    assert.ok(farAbove < oneAbove)
  })

  it('discounts someone in a different function', () => {
    assert.ok(
      authorityScore(prospect({ sameFunction: false })) <
        authorityScore(prospect({ sameFunction: true })),
    )
  })

  it('rewards recent joiners', () => {
    // A referral bonus to claim and less loyalty friction.
    const fresh = recencyScore(prospect({ monthsAtCompany: 8 }))
    const settled = recencyScore(prospect({ monthsAtCompany: 30 }))
    const veteran = recencyScore(prospect({ monthsAtCompany: 120 }))
    assert.ok(fresh > settled)
    assert.ok(settled > veteran)
  })

  it('puts an existing connection above a stranger with a better title', () => {
    const connected = scoreProspect(prospect({ relationship: 'first_degree', degree: 1, levelDelta: 0 }))
    const strangerAbove = scoreProspect(prospect({ relationship: 'cold', levelDelta: 1 }))
    assert.ok(
      connected.score > strangerAbove.score,
      'someone who already accepted you needs no invite and converts best',
    )
  })

  it('values a shared employer over nothing at all', () => {
    const shared = scoreProspect(prospect({ relationship: 'ex_colleague', sharedEmployer: true }))
    const cold = scoreProspect(prospect({ relationship: 'cold' }))
    assert.ok(shared.score > cold.score)
  })

  it('collects the signals a draft can honestly open with', () => {
    const ranked = scoreProspect(
      prospect({ sharedSchool: true, mutualConnections: 3, monthsAtCompany: 10 }),
    )
    assert.ok(ranked.signals.includes('same school'))
    assert.ok(ranked.signals.some((signal) => signal.includes('3 mutual')))
    assert.ok(ranked.signals.includes('joined recently'))
  })

  it('keeps the per-company list small', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      prospect({ profileUrl: `p${index}`, mutualConnections: index }),
    )
    assert.ok(rankProspects(many).length <= 8)
  })

  it('returns them best-first', () => {
    const ranked = rankProspects([
      prospect({ profileUrl: 'cold', relationship: 'cold' }),
      prospect({ profileUrl: 'known', relationship: 'first_degree', degree: 1 }),
    ])
    assert.equal(ranked[0]?.profileUrl, 'known')
  })

  it('refuses a cold message to a stranger with nothing in common', () => {
    // That is the outreach that gets reported rather than answered.
    const nobody = scoreProspect(
      prospect({ relationship: 'cold', sameFunction: false, monthsAtCompany: 120, activeRecently: false }),
    )
    assert.equal(worthContacting(nobody), false)
  })

  it('always contacts someone already connected', () => {
    const known = scoreProspect(prospect({ relationship: 'first_degree', degree: 1 }))
    assert.equal(worthContacting(known), true)
  })
})
