import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  canSend,
  DEFAULT_LIMITS,
  localHour,
  nextGapMs,
  shouldWithdraw,
  type SendabilityInput,
} from './limits.js'

/** A request that would otherwise be allowed, so each test changes one thing. */
function sendable(overrides: Partial<SendabilityInput> = {}): SendabilityInput {
  return {
    // 12:00 in Asia/Kolkata — inside the window.
    now: new Date('2026-09-01T06:30:00.000Z'),
    timezone: 'Asia/Kolkata',
    invitesToday: 0,
    invitesThisWeek: 0,
    invitesToThisCompanyToday: 0,
    pausedUntil: null,
    approved: true,
    ...overrides,
  }
}

describe('outreach rails', () => {
  it('allows a send that satisfies everything', () => {
    assert.equal(canSend(sendable()).ok, true)
  })

  it('refuses anything a human has not approved, before any other check', () => {
    // Checked first on purpose: an unapproved message must not send even when
    // every other condition is fine.
    const verdict = canSend(sendable({ approved: false }))
    assert.equal(verdict.ok, false)
    assert.equal(verdict.refusal, 'not_approved')
  })

  it('refuses while the circuit breaker is open', () => {
    const verdict = canSend(
      sendable({ pausedUntil: new Date('2026-09-03T00:00:00.000Z') }),
    )
    assert.equal(verdict.refusal, 'breaker_open')
  })

  it('lets sending resume once the breaker has expired', () => {
    const verdict = canSend(sendable({ pausedUntil: new Date('2026-08-30T00:00:00.000Z') }))
    assert.equal(verdict.ok, true)
  })

  it('refuses outside the user’s own waking hours', () => {
    // 03:00 in Kolkata. Invites at three in the morning are the clearest
    // automation tell there is.
    const verdict = canSend(sendable({ now: new Date('2026-08-31T21:30:00.000Z') }))
    assert.equal(verdict.refusal, 'outside_send_window')
  })

  it('uses the user’s timezone, not the server’s', () => {
    // The same instant is 12:00 in Kolkata and 06:30 UTC — inside one window
    // and outside a UTC-based one.
    const instant = new Date('2026-09-01T06:30:00.000Z')
    assert.equal(localHour(instant, 'Asia/Kolkata'), 12)
    assert.equal(canSend(sendable({ now: instant, timezone: 'Asia/Kolkata' })).ok, true)
    assert.equal(
      canSend(sendable({ now: instant, timezone: 'America/Los_Angeles' })).refusal,
      'outside_send_window',
    )
  })

  it('falls back to UTC rather than throwing on a bad timezone', () => {
    assert.equal(typeof localHour(new Date(), 'Not/AZone'), 'number')
  })

  it('enforces the daily cap', () => {
    assert.equal(canSend(sendable({ invitesToday: DEFAULT_LIMITS.invitesPerDay })).refusal, 'daily_cap')
    assert.equal(canSend(sendable({ invitesToday: DEFAULT_LIMITS.invitesPerDay - 1 })).ok, true)
  })

  it('enforces the weekly cap even when today is quiet', () => {
    // The weekly ceiling is the one LinkedIn actually watches, so it is
    // checked before the daily one.
    const verdict = canSend(
      sendable({ invitesToday: 0, invitesThisWeek: DEFAULT_LIMITS.invitesPerWeek }),
    )
    assert.equal(verdict.refusal, 'weekly_cap')
  })

  it('enforces the per-company cap', () => {
    const verdict = canSend(
      sendable({ invitesToThisCompanyToday: DEFAULT_LIMITS.perCompanyPerDay }),
    )
    assert.equal(verdict.refusal, 'company_cap')
  })

  it('keeps the defaults well under LinkedIn’s own ceiling', () => {
    // LinkedIn's weekly invite limit starts around 100. If a future edit
    // pushes these up, this test is the thing that should stop it.
    assert.ok(DEFAULT_LIMITS.invitesPerWeek <= 80, 'weekly cap drifted too close to the ceiling')
    assert.ok(DEFAULT_LIMITS.invitesPerDay <= 20, 'daily cap drifted too high')
    assert.ok(DEFAULT_LIMITS.perCompanyPerDay <= 8)
  })

  it('gives every refusal a reason a person can read', () => {
    for (const input of [
      sendable({ approved: false }),
      sendable({ invitesToday: 99 }),
      sendable({ invitesThisWeek: 999 }),
      sendable({ invitesToThisCompanyToday: 99 }),
      sendable({ now: new Date('2026-08-31T21:30:00.000Z') }),
    ]) {
      const verdict = canSend(input)
      assert.equal(verdict.ok, false)
      assert.ok(verdict.because && verdict.because.length > 10, 'refusals must explain themselves')
    }
  })

  it('jitters the gap rather than sending on a metronome', () => {
    assert.equal(nextGapMs(DEFAULT_LIMITS, () => 0), DEFAULT_LIMITS.minGapMs)
    assert.equal(nextGapMs(DEFAULT_LIMITS, () => 1), DEFAULT_LIMITS.maxGapMs)
    const mid = nextGapMs(DEFAULT_LIMITS, () => 0.5)
    assert.ok(mid > DEFAULT_LIMITS.minGapMs && mid < DEFAULT_LIMITS.maxGapMs)
  })

  it('withdraws stale invites, because a low acceptance rate is itself a flag', () => {
    const invitedAt = new Date('2026-08-01T00:00:00.000Z')
    assert.equal(shouldWithdraw(invitedAt, new Date('2026-08-10T00:00:00.000Z')), false)
    assert.equal(shouldWithdraw(invitedAt, new Date('2026-08-23T00:00:00.000Z')), true)
  })
})
