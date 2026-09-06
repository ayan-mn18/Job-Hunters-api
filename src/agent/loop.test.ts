import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { trim } from './loop.js'
import type { MuseMessage } from '../model/muse-spark.js'

/**
 * A tool reply separated from the assistant message that requested it is a 400
 * from the model API, not a degraded prompt — so the cut is a correctness
 * concern, not a cost one. A live run died at step six on exactly this.
 */
describe('conversation trimming', () => {
  const pinned: MuseMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'goal' },
  ]

  function turn(index: number): MuseMessage[] {
    return [
      { role: 'user', content: `observation ${index}` },
      { role: 'assistant', content: '', tool_calls: [{ id: `call_${index}` }] },
      { role: 'tool', tool_call_id: `call_${index}`, content: 'OK' },
    ]
  }

  it('leaves a short conversation alone', () => {
    const messages = [...pinned, ...turn(1)]
    assert.deepEqual(trim(messages), messages)
  })

  it('always keeps the system message and the goal', () => {
    const messages = [...pinned, ...Array.from({ length: 12 }, (_, index) => turn(index)).flat()]
    const kept = trim(messages)
    assert.equal(kept[0]?.role, 'system')
    assert.equal(kept[1]?.role, 'user')
  })

  it('never starts the tail with an orphaned tool reply', () => {
    for (let turns = 5; turns < 15; turns += 1) {
      for (let keep = 3; keep < 20; keep += 1) {
        const messages = [...pinned, ...Array.from({ length: turns }, (_, index) => turn(index)).flat()]
        const kept = trim(messages, keep)
        assert.notEqual(kept[2]?.role, 'tool', `keep=${keep} turns=${turns} orphaned a tool reply`)
      }
    }
  })

  it('keeps every tool reply paired with its assistant message', () => {
    const messages = [...pinned, ...Array.from({ length: 10 }, (_, index) => turn(index)).flat()]
    const kept = trim(messages, 7)
    for (let index = 0; index < kept.length; index += 1) {
      if (kept[index]?.role !== 'tool') continue
      const before = kept[index - 1]
      assert.ok(before?.role === 'assistant' && before.tool_calls, 'a tool reply lost its assistant')
    }
  })
})
