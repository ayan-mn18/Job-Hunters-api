import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractReferrals,
  isReferralRequest,
  parseLinkedInMessageDate,
  type RawLinkedInMessage,
} from './linkedin-referrals.js'

const NOW = new Date('2026-08-08T12:00:00.000Z')

function message(overrides: Partial<RawLinkedInMessage> = {}): RawLinkedInMessage {
  return {
    id: 'urn:li:message:123',
    body: 'Hi, could you please refer me for the Senior Backend Engineer role? Job ID JR-48210. Resume: attached.',
    senderName: 'Priya Shah',
    senderProfileUrl: 'https://www.linkedin.com/in/priya-shah',
    timestamp: '2026-08-07T10:30:00.000Z',
    outbound: false,
    links: [
      {
        href: 'https://www.linkedin.com/dms/prv/attachment/abc',
        text: 'Priya-Shah-Resume.pdf',
        download: 'Priya-Shah-Resume.pdf',
      },
    ],
    ...overrides,
  }
}

describe('LinkedIn referral extraction', () => {
  it('recognises direct referral requests', () => {
    assert.equal(isReferralRequest('Could you please refer me for this opening?'), true)
    assert.equal(isReferralRequest('I am seeking a referral at Acme.'), true)
    assert.equal(isReferralRequest('Thanks for connecting. How are you?'), false)
  })

  it('recognises long Visa referral templates', () => {
    assert.equal(
      isReferralRequest(
        "If you feel my profile is a good fit, I'd be grateful if you could refer me for the role. I've attached my resume.",
      ),
      true,
    )
    assert.equal(
      isReferralRequest(
        'Please review my resume and if you feel I am a good fit then please refer my profile for above-mentioned role.',
      ),
      true,
    )
  })

  it('extracts Workday and LinkedIn job identifiers', () => {
    const workday = extractReferrals(
      [
        message({
          body: 'Referral Request for Software Engineer – REF082722W',
        }),
      ],
      new Date('2026-08-01T00:00:00.000Z'),
    )
    const linkedIn = extractReferrals(
      [
        message({
          id: 'linkedin-job',
          body: "I'd be grateful if you could refer me for the Software Engineer role. Job link: https://www.linkedin.com/jobs/view/4433092549/",
        }),
      ],
      new Date('2026-08-01T00:00:00.000Z'),
    )

    assert.equal(workday[0]?.jobRequisitionId, 'REF082722W')
    assert.equal(linkedIn[0]?.jobRequisitionId, '4433092549')
    const mistypedPrefix = extractReferrals(
      [
        message({
          id: 'mistyped-job-id',
          body: 'Could you please refer me? jobId: jREF082672W',
        }),
      ],
      new Date('2026-08-01T00:00:00.000Z'),
    )

    assert.equal(mistypedPrefix[0]?.jobRequisitionId, 'REF082672W')
    assert.equal(linkedIn[0]?.targetRole, 'Software Engineer')
  })

  it('extracts opportunity-style role names', () => {
    const referrals = extractReferrals(
      [
        message({
          body: 'Recently I found that there is opportunity of Software Engineer 1 role at Visa. Please refer my profile.',
        }),
      ],
      new Date('2026-08-01T00:00:00.000Z'),
    )

    assert.equal(referrals[0]?.targetRole, 'Software Engineer 1')
  })

  it('parses LinkedIn date headings and group times', () => {
    const parsed = parseLinkedInMessageDate('Aug 6||10:47 AM', NOW)
    const weekday = parseLinkedInMessageDate('Wednesday||4:15 PM', NOW)

    assert.equal(parsed?.getFullYear(), 2026)
    assert.equal(parsed?.getMonth(), 7)
    assert.equal(parsed?.getDate(), 6)
    assert.equal(parsed?.getHours(), 10)
    assert.equal(parsed?.getMinutes(), 47)
    assert.equal(weekday?.getDay(), 3)
    assert.equal(weekday?.getHours(), 16)
    assert.equal(weekday?.getMinutes(), 15)
  })

  it('extracts the message, job id, profile and resume link', () => {
    const referrals = extractReferrals([message()], new Date('2026-08-01T00:00:00.000Z'))

    assert.equal(referrals.length, 1)
    assert.equal(referrals[0]?.externalMessageId, 'urn:li:message:123')
    assert.equal(referrals[0]?.requesterName, 'Priya Shah')
    assert.equal(referrals[0]?.jobRequisitionId, 'JR-48210')
    assert.equal(referrals[0]?.requesterProfileUrl, 'https://www.linkedin.com/in/priya-shah')
    assert.equal(referrals[0]?.resumeName, 'Priya-Shah-Resume.pdf')
    assert.equal(referrals[0]?.resumeUrl, 'https://www.linkedin.com/dms/prv/attachment/abc')
  })

  it('ignores outbound and old messages', () => {
    const referrals = extractReferrals(
      [
        message({ id: 'outbound', outbound: true }),
        message({ id: 'old', timestamp: '2026-07-01T10:30:00.000Z' }),
      ],
      new Date(NOW.getTime() - 7 * 86_400_000),
    )

    assert.deepEqual(referrals, [])
  })
})
