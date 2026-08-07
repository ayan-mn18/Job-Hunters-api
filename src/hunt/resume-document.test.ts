import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildResumeDocument, resumeDocumentSchema } from './resume-document.js'

const parsed = {
  skills: ['TypeScript', 'React'],
  titles: ['Senior Engineer'],
  yearsExperience: 5,
  employments: [{
    role: 'Senior Engineer',
    company: 'Acme',
    startedOn: '2021-01-01',
    endedOn: null,
    isCurrent: true,
    blurb: 'Built a TypeScript platform serving enterprise customers.',
  }],
  contact: {
    fullName: 'Ayan Mansoori',
    email: 'ayan@example.com',
    phone: '+91 98765 43210',
    city: 'Pune',
    linkedinUrl: 'https://linkedin.com/in/ayan',
  },
  rawText: 'resume',
}

describe('structured resume document', () => {
  it('creates stable references from parsed facts', () => {
    const first = buildResumeDocument(parsed)
    const second = buildResumeDocument(parsed)
    assert.deepEqual(first, second)
    assert.equal(resumeDocumentSchema.safeParse(first).success, true)
    assert.equal(first.experience[0]?.bullets[0]?.skills[0], 'TypeScript')
  })
})
