import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planApplicationOrder } from './application-queue.js'

function rows(portal: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `${portal}-${index}`, portal }))
}

describe('application budget planning', () => {
  it('caps the day at 100 and rotates sources', () => {
    const planned = planApplicationOrder([
      ...rows('greenhouse', 50),
      ...rows('ashby', 40),
      ...rows('lever', 40),
      ...rows('jobicy', 40),
    ], 100)

    assert.equal(planned.length, 100)
    assert.equal(new Set(planned.slice(0, 4).map((row) => row.portal)).size, 4)
    const counts = planned.reduce<Record<string, number>>((result, row) => {
      result[row.portal] = (result[row.portal] ?? 0) + 1
      return result
    }, {})
    assert.ok((counts.greenhouse ?? 0) <= 35)
    assert.ok((counts.ashby ?? 0) <= 30)
    assert.ok((counts.lever ?? 0) <= 30)
    assert.ok((counts.jobicy ?? 0) <= 30)
  })

  it('honours a smaller run target', () => {
    assert.equal(planApplicationOrder(rows('jobicy', 50), 12).length, 12)
  })
})
