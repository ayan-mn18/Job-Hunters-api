import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { levelDeltaFor, toProspect, type CandidateContext } from './find.js'
import { scoreProspect } from './rank.js'

const candidate: CandidateContext = {
  targetRole: 'Backend Engineer',
  targetIsSenior: false,
  pastEmployers: ['Freshworks'],
  schools: [],
  city: 'Bengaluru',
  skills: ['node', 'postgres'],
}

function person(overrides: Partial<Parameters<typeof toProspect>[0]> = {}) {
  return toProspect(
    {
      profileUrl: 'https://www.linkedin.com/in/someone',
      name: 'A Person',
      title: 'Software Engineer',
      degree: 2,
      mutualConnections: 0,
      location: null,
      ...overrides,
    },
    candidate,
  )
}

describe('prospect discovery', () => {
  it('reads seniority out of a title', () => {
    assert.equal(levelDeltaFor('Senior Software Engineer', false), 1)
    assert.equal(levelDeltaFor('Software Engineer', false), 0)
    assert.equal(levelDeltaFor('Junior Developer', true), -1)
  })

  it('treats a VP as too far above to be useful', () => {
    // Two levels up they are approving headcount, not reading your code.
    assert.equal(levelDeltaFor('VP of Engineering', false), 2)
    assert.equal(levelDeltaFor('Head of Platform', false), 2)
  })

  it('scores one level above highest, and a VP below a peer', () => {
    const peer = scoreProspect(person({ title: 'Software Engineer' }))
    const oneAbove = scoreProspect(person({ title: 'Senior Software Engineer' }))
    const vp = scoreProspect(person({ title: 'VP of Engineering' }))

    assert.ok(oneAbove.score >= peer.score, 'one level above should not score below a peer')
    assert.ok(vp.score < peer.score, 'a VP should score below someone who could actually vouch')
  })

  it('ranks an existing connection above a stranger', () => {
    const connected = scoreProspect(person({ degree: 1 }))
    const stranger = scoreProspect(person({ degree: 3 }))
    assert.ok(connected.score > stranger.score)
    assert.equal(connected.relationship, 'first_degree')
  })

  it('recognises a recruiter as a different kind of ask', () => {
    const recruiter = person({ title: 'Technical Recruiter' })
    assert.equal(recruiter.isRecruiter, true)
    assert.equal(recruiter.sameFunction, false)
  })

  it('does not treat a non-engineering title as the same function', () => {
    assert.equal(person({ title: 'Product Manager' }).sameFunction, false)
    assert.equal(person({ title: 'Backend Engineer' }).sameFunction, true)
  })

  it('never invents a shared school or city from a search card', () => {
    // A search result publishes neither. An invented "we went to the same
    // university" in a draft would be worse than a duller note.
    const found = person()
    assert.equal(found.sharedSchool, false)
    assert.equal(found.sharedCity, false)
  })

  it('spots an ex-colleague from the title text', () => {
    const found = person({ title: 'Engineer, ex-Freshworks', degree: 2 })
    assert.equal(found.relationship, 'ex_colleague')
    assert.equal(found.sharedEmployer, true)
  })

  it('treats several mutuals as a warm introduction', () => {
    assert.equal(person({ degree: 2, mutualConnections: 5 }).relationship, 'strong_mutual')
    assert.equal(person({ degree: 2, mutualConnections: 1 }).relationship, 'cold')
  })
})
