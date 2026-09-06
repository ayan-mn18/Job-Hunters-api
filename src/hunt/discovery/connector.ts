import type { DiscoveryAdapter } from './types.js'

/**
 * What a source *is*, as opposed to what it does.
 *
 * The existing `SourceAdapter` describes behaviour — how to list, how to fetch
 * a detail page — and the shared pipeline in `runner.ts` handles the rest.
 * This adds the facts a planner needs before it can decide whether to use a
 * source at all: can it take a keyword, which markets does it cover, and does
 * using it mean borrowing the user's account.
 *
 * The tiers are not bookkeeping. They separate sources we can depend on from
 * sources where the user is lending us their logged-in session, and those two
 * things deserve different defaults.
 */

export type ConnectorTier =
  /** Licensed search APIs. Keyword and location aware, no session, no ToS risk. */
  | 1
  /** Employer ATS boards. Best data and the most reliable apply URLs. */
  | 2
  /** The user's own authenticated session. Opt-in, off by default. */
  | 3

export interface ConnectorMeta {
  id: string
  tier: ConnectorTier
  /**
   * ISO-3166 alpha-2 codes this source actually covers, plus `remote` for
   * location-independent postings and `*` for "anywhere".
   */
  markets: string[]
  /** True when the user must connect an account before this can run. */
  needsSession: boolean
  supports: {
    /** Accepts a keyword. False means it lists whatever is recent. */
    keyword: boolean
    /** Accepts a location or market. */
    location: boolean
  }
  /** Set when a source is configured by env and the env is missing. */
  unavailableReason?: string
}

export interface JobConnector extends ConnectorMeta {
  adapter: DiscoveryAdapter
}

/** Crawl sources: no keyword, no market targeting, list what is recent. */
export function crawlMeta(
  id: string,
  overrides: Partial<Omit<ConnectorMeta, 'id'>> = {},
): Omit<ConnectorMeta, 'id'> & { id: string } {
  return {
    id,
    tier: 2,
    markets: ['*'],
    needsSession: false,
    supports: { keyword: false, location: false },
    ...overrides,
  }
}

/** True when this connector can serve a query aimed at the given market. */
export function servesMarket(connector: ConnectorMeta, market: string | null): boolean {
  if (connector.markets.includes('*')) return true
  if (market === null) return true
  return connector.markets.includes(market)
}

export function isAvailable(connector: ConnectorMeta): boolean {
  return !connector.unavailableReason
}
