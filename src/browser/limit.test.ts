import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSemaphore, type Slot } from './limit.js'

/**
 * The failure this guards against is not a slow run — it is the provider
 * refusing a browser, which surfaces as an application failing for a reason
 * that has nothing to do with the application. So the invariant is exact:
 * never more than `limit` slots outstanding, whatever order things release in.
 */
describe('browser concurrency limit', () => {
  it('hands out up to the limit without waiting', async () => {
    const semaphore = createSemaphore(4)
    const slots = await Promise.all(
      Array.from({ length: 4 }, (_, index) => semaphore.acquire(`job-${index}`, 1_000)),
    )
    assert.equal(semaphore.active, 4)
    assert.equal(semaphore.waiting, 0)
    for (const slot of slots) slot.release()
    assert.equal(semaphore.active, 0)
  })

  it('queues callers past the limit, and serves them on release', async () => {
    const semaphore = createSemaphore(2)
    const first = await semaphore.acquire('a', 1_000)
    await semaphore.acquire('b', 1_000)

    const pending = semaphore.acquire('c', 1_000)
    assert.equal(semaphore.waiting, 1)
    assert.equal(semaphore.active, 2)

    first.release()
    const third = await pending
    // The slot was handed over, not re-counted: still two browsers, not three.
    assert.equal(semaphore.active, 2)
    assert.equal(semaphore.waiting, 0)
    third.release()
  })

  it('gives up rather than waiting forever', async () => {
    const semaphore = createSemaphore(1)
    const held = await semaphore.acquire('holder', 1_000)
    await assert.rejects(semaphore.acquire('waiter', 20), /busy/i)
    // A caller that gave up must leave the queue, or the next release hands a
    // slot to nobody and it is never returned.
    assert.equal(semaphore.waiting, 0)
    held.release()
    assert.equal(semaphore.active, 0)
  })

  it('ignores a double release', async () => {
    const semaphore = createSemaphore(2)
    const slot = await semaphore.acquire('a', 1_000)
    slot.release()
    slot.release()
    assert.equal(semaphore.active, 0)
  })

  it('never exceeds the limit under contention', async () => {
    const limit = 4
    const semaphore = createSemaphore(limit)
    let live = 0
    let peak = 0

    await Promise.all(
      Array.from({ length: 30 }, async (_, index) => {
        const slot: Slot = await semaphore.acquire(`job-${index}`, 5_000)
        live += 1
        peak = Math.max(peak, live)
        await new Promise((resolve) => setTimeout(resolve, index % 5))
        live -= 1
        slot.release()
      }),
    )

    assert.equal(peak, limit)
    assert.equal(semaphore.active, 0)
    assert.equal(semaphore.waiting, 0)
  })
})
