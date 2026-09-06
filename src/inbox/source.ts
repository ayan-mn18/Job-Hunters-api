/**
 * Where mail comes from.
 *
 * Two implementations behind one interface, because the choice between them is
 * a business decision that has not been made yet and should not be baked into
 * the consumer.
 *
 * `gmail-oauth` reads the user's mailbox directly. It needs the `gmail.readonly`
 * scope, which Google classes as *restricted*: a public app using it must pass
 * an annual CASA security assessment. Under the OAuth consent screen's testing
 * mode that is free for up to 100 users, which covers this product's first
 * hundred customers and no more.
 *
 * `forwarding` sidesteps the scope entirely: the user sets one Gmail filter
 * that forwards job-related mail to an address we own. Less magical, no
 * assessment, no annual renewal, and it never stops working.
 */

export interface RawEmail {
  externalId: string
  threadId: string | null
  fromAddress: string
  fromName: string | null
  subject: string
  snippet: string
  body: string
  receivedAt: Date
}

export interface InboxSource {
  readonly kind: 'gmail-oauth' | 'forwarding'
  /**
   * Fetches everything since `cursor`, and returns the cursor to store for
   * next time. A source that cannot do deltas returns the same cursor back.
   */
  poll(
    userId: string,
    cursor: string | null,
  ): Promise<{ messages: RawEmail[]; cursor: string | null }>
}
