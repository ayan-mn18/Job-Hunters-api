import type { InboxSource } from './source.js'

/**
 * The no-scope path.
 *
 * The user sets one Gmail filter that forwards job-related mail to an address
 * we own; a webhook writes those messages straight into `email_messages`.
 * There is nothing to poll, so `poll` is a no-op that reports honestly rather
 * than pretending to fetch.
 *
 * Less magical than reading someone's mailbox, and it needs no restricted
 * scope, no annual security assessment, and no 100-user ceiling. That trade is
 * why the interface exists.
 */
export const forwardingSource: InboxSource = {
  kind: 'forwarding',
  async poll(_userId, cursor) {
    return { messages: [], cursor }
  },
}
