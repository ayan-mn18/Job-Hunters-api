import { DISCOVERY_ADAPTERS } from './adapters.js'
import { adzunaMeta, adzunaSource } from './connectors/adzuna.js'
import { googleJobsMeta, googleJobsSource } from './connectors/google-jobs.js'
import { joobleMeta, joobleSource } from './connectors/jooble.js'
import { toDiscoveryAdapter } from './runner.js'
import type { ConnectorMeta, JobConnector } from './connector.js'
import type { DiscoveryAdapter } from './types.js'

/**
 * Every source, with the facts a planner needs to choose between them.
 *
 * The tier-2 entries are the adapters that already existed; they gain metadata
 * and nothing else. The tier-1 entries are new, and they are the ones that can
 * take a keyword — which is the difference between a search and a crawl.
 */

/** Crawl sources: they list what is recent and ignore the query plan. */
const CRAWL_META: Record<string, Omit<ConnectorMeta, 'id'>> = {
  greenhouse: { tier: 2, markets: ['*'], needsSession: false, supports: { keyword: false, location: false } },
  lever: { tier: 2, markets: ['*'], needsSession: false, supports: { keyword: false, location: false } },
  ashby: { tier: 2, markets: ['*'], needsSession: false, supports: { keyword: false, location: false } },
  smartrecruiters: { tier: 2, markets: ['*'], needsSession: false, supports: { keyword: false, location: false } },
  workable: { tier: 2, markets: ['*'], needsSession: false, supports: { keyword: false, location: false } },
  // Remote boards are location-independent by construction.
  remotive: { tier: 2, markets: ['remote'], needsSession: false, supports: { keyword: false, location: false } },
  jobicy: { tier: 2, markets: ['remote'], needsSession: false, supports: { keyword: false, location: false } },
  arbeitnow: { tier: 2, markets: ['remote', 'DE'], needsSession: false, supports: { keyword: false, location: false } },
  remoteok: { tier: 2, markets: ['remote'], needsSession: false, supports: { keyword: false, location: false } },
  weworkremotely: { tier: 2, markets: ['remote'], needsSession: false, supports: { keyword: false, location: false } },
  workatastartup: { tier: 2, markets: ['remote', 'US'], needsSession: false, supports: { keyword: false, location: false } },
  // Instahyre is India-only and scraped from public pages, not an account.
  instahyre: { tier: 2, markets: ['IN'], needsSession: false, supports: { keyword: false, location: false } },
}

const SEARCH_CONNECTORS: Array<{ meta: ConnectorMeta; adapter: DiscoveryAdapter }> = [
  { meta: googleJobsMeta, adapter: toDiscoveryAdapter(googleJobsSource) },
  { meta: adzunaMeta, adapter: toDiscoveryAdapter(adzunaSource) },
  { meta: joobleMeta, adapter: toDiscoveryAdapter(joobleSource) },
]

function crawlConnectors(): JobConnector[] {
  return DISCOVERY_ADAPTERS.flatMap((adapter): JobConnector[] => {
    const meta = CRAWL_META[adapter.id]
    if (!meta) return []
    return [{ id: adapter.id, ...meta, adapter }]
  })
}

export function allConnectors(): JobConnector[] {
  return [
    ...SEARCH_CONNECTORS.map(({ meta, adapter }) => ({ ...meta, adapter })),
    ...crawlConnectors(),
  ]
}

/**
 * The connectors a run should use.
 *
 * Tier-1 search connectors are always included when configured: they are the
 * only ones that can act on what the user actually asked for, so leaving them
 * out because a user has not ticked a portal box would defeat the point.
 * Tier-2 crawl sources respect the user's portal selection.
 */
export function connectorsForRun(options: {
  enabledPortalIds: string[]
  /** Session-backed sources stay out unless the user has opted in. */
  allowSessionSources?: boolean
}): { connectors: JobConnector[]; skipped: Array<{ id: string; reason: string }> } {
  const enabled = new Set(options.enabledPortalIds)
  const connectors: JobConnector[] = []
  const skipped: Array<{ id: string; reason: string }> = []

  for (const connector of allConnectors()) {
    if (connector.unavailableReason) {
      skipped.push({ id: connector.id, reason: connector.unavailableReason })
      continue
    }
    if (connector.needsSession && !options.allowSessionSources) {
      skipped.push({ id: connector.id, reason: 'Needs a connected account; not enabled.' })
      continue
    }
    if (connector.tier === 1) {
      connectors.push(connector)
      continue
    }
    if (enabled.size === 0 || enabled.has(connector.id)) connectors.push(connector)
  }

  return { connectors, skipped }
}

/** For the portals screen: what each source is and whether it can run. */
export function connectorStatus(): Array<ConnectorMeta & { label: string }> {
  return allConnectors().map(({ adapter, ...meta }) => ({ ...meta, label: adapter.label }))
}
