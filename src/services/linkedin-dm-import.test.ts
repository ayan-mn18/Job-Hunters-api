import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { auditLinkedInDmExport } from './linkedin-dm-import.js'

describe('LinkedIn DM import audit', () => {
  it('imports inbound referral requests only', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'linkedin-import-test-'))
    const filePath = path.join(directory, 'messages.json')
    try {
      await writeFile(filePath, JSON.stringify({
        conversations: [{
          title: 'Priya Shah',
          messages: [
            {
              id: 'hello',
              body: 'Thanks for connecting.',
              senderName: 'Priya Shah',
              timestamp: '2026-08-08T10:00:00.000Z',
              outbound: false,
              links: [],
            },
            {
              id: 'referral',
              body: 'Could you please refer me for the Senior Backend Engineer role? Job ID REF12345.',
              senderName: 'Priya Shah',
              senderProfileUrl: 'https://www.linkedin.com/in/priya',
              timestamp: '2026-08-08T10:05:00.000Z',
              outbound: false,
              links: [],
            },
            {
              id: 'outbound',
              body: 'I will refer you.',
              senderName: 'You',
              timestamp: '2026-08-08T10:06:00.000Z',
              outbound: true,
              links: [],
            },
          ],
        }],
      }))
      const result = await auditLinkedInDmExport(filePath)
      assert.equal(result.audit.messages, 3)
      assert.equal(result.audit.inboundMessages, 2)
      assert.equal(result.audit.referralRequests, 1)
      assert.equal(result.audit.withTargetRole, 1)
      assert.equal(result.audit.withJobId, 1)
      assert.equal(result.referrals[0]?.externalMessageId, 'referral')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
