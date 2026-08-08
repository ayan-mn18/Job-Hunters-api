import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractReferrals,
  isReferralRequest,
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
