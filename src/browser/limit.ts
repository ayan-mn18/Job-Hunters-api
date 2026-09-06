import { serviceUnavailable } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

/**
 * A ceiling on how many browsers exist at once, across the whole process.
 *
 * Capping the apply queue was the obvious move and it does not work: applying
 * is not the only thing that opens a browser. LinkedIn outreach, the referral
 * sync, interactive sign-in and the verification scripts each open their own,
 * so a limit that only counts applications counts a fraction of the browsers
 * and calls it the total.
 *
 * The number matters because the provider enforces its own. Browser Use allows
 * ten concurrent sessions until a lifetime spend threshold is passed, and the
 * eleventh is refused rather than queued — which surfaces as an application
 * failing for a reason that has nothing to do with the application.
 *
 * Waiters are served in order and each carries its own deadline, because the
 * right thing to do when every browser is busy depends on who is asking. A
 * queued apply job can happily wait a minute. A person who just clicked
 * "connect LinkedIn" should be told to try again, not left watching a spinner.
 */

export interface Slot {
  release(): void
}

interface Waiter {
  resolve: (slot: Slot) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  label: string
}

export interface Semaphore {
  acquire(label: string, maxWaitMs: number): Promise<Slot>
  /** For logging and tests. */
  readonly active: number
  readonly waiting: number
}

export function createSemaphore(limit: number): Semaphore {
  let active = 0
  const queue: Waiter[] = []

  function makeSlot(): Slot {
    let released = false
    return {
      release() {
        // Idempotent: `close()` is called from a `finally` and sometimes again
        // by a caller being careful, and a double release would hand out a
        // slot that does not exist.
        if (released) return
        released = true

        const next = queue.shift()
        if (next) {
          // Hand the slot straight over rather than decrementing and letting
          // the waiter re-check: between those two steps a new caller could
          // take it, and the queue would never drain under load.
          clearTimeout(next.timer)
          next.resolve(makeSlot())
          return
        }
        active -= 1
      },
    }
  }

  return {
    get active() {
      return active
    },
    get waiting() {
      return queue.length
    },
    acquire(label: string, maxWaitMs: number): Promise<Slot> {
      if (active < limit) {
        active += 1
        return Promise.resolve(makeSlot())
      }

      logger.debug({ label, active, waiting: queue.length, limit }, 'waiting for a free browser')

      return new Promise<Slot>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          label,
          timer: setTimeout(() => {
            // Drop out of the queue first, or a later release hands a slot to
            // a caller that has already given up — and nothing would ever
            // release it.
            const index = queue.indexOf(waiter)
            if (index >= 0) queue.splice(index, 1)
            reject(
              serviceUnavailable(
                `All ${limit} browsers are busy. Try again in a moment.`,
              ),
            )
          }, maxWaitMs),
        }
        queue.push(waiter)
      })
    },
  }
}
