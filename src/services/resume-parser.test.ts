import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getResumeParser, parseResumeText, readParsedResume } from './resume-parser.js'

const SAMPLE_RESUME = `Ayan Mansoori
ayan@example.com | +91 98765 43210 | linkedin.com/in/ayan-mansoori | github.com/ayan
Location: Bengaluru, Karnataka
https://ayan.dev

SUMMARY
Backend engineer with 7+ years of experience building reliable products.

EXPERIENCE
Senior Software Engineer
Acme Labs
Jan 2021 - Present
- Led a TypeScript and PostgreSQL billing platform rewrite.

Software Engineer
Beta Systems
Jun 2018 - Dec 2020
- Built React and Node.js customer workflows.

SKILLS
TypeScript, React, Node.js, PostgreSQL, AWS

EDUCATION
B.Tech, Example University
`

describe('resume parser', () => {
  it('extracts autofill fields from resume text', () => {
    const parsed = parseResumeText(SAMPLE_RESUME)

    assert.equal(parsed.contact.fullName, 'Ayan Mansoori')
    assert.equal(parsed.contact.email, 'ayan@example.com')
    assert.equal(parsed.contact.phone, '+91 98765 43210')
    assert.equal(parsed.contact.city, 'Bengaluru')
    assert.equal(parsed.contact.linkedinUrl, 'linkedin.com/in/ayan-mansoori')
    assert.equal(parsed.contact.githubUrl, 'github.com/ayan')
    assert.equal(parsed.contact.portfolioUrl, 'https://ayan.dev')
    assert.equal(parsed.yearsExperience, 7)
    assert.deepEqual(parsed.titles, ['Senior Software Engineer', 'Software Engineer'])
    assert.deepEqual(parsed.skills.slice(0, 5), [
      'TypeScript',
      'React',
      'Node.js',
      'PostgreSQL',
      'AWS',
    ])
    assert.equal(parsed.employments.length, 2)
    assert.deepEqual(parsed.employments[0], {
      role: 'Senior Software Engineer',
      company: 'Acme Labs',
      startedOn: '2021-01-01',
      endedOn: null,
      isCurrent: true,
      blurb: 'Led a TypeScript and PostgreSQL billing platform rewrite.',
    })
  })

  it('reads TXT bytes through the production parser', async () => {
    const parsed = await getResumeParser().parse({
      resumeId: 'resume-id',
      userId: 'user-id',
      fileName: 'resume.txt',
      mimeType: 'text/plain',
      storagePath: 'users/user-id/resume.txt',
      buffer: Buffer.from(SAMPLE_RESUME),
    })

    assert.equal(parsed.titles[0], 'Senior Software Engineer')
    assert.ok(parsed.skills.includes('TypeScript'))
  })

  it('rejects malformed stored profiles', () => {
    assert.equal(readParsedResume({ skills: [] }), null)
  })
})
