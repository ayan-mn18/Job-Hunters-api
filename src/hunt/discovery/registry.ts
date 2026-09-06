import { hasFirecrawl } from '../../config/env.js'
import { skillsWith } from '../../skills/registry.js'
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

/**
 * Sources that come from a site skill.
 *
 * Work at a Startup is the first: its old adapter read the page directly and
 * stopped working when the site began answering plain HTTP clients with 406,
 * so it now reads through Firecrawl and lives with the rest of what this
 * project knows about that site. Without a Firecrawl key it reports itself
 * unavailable rather than contributing an empty list, which is what the old
 * one silently did.
 */
function skillConnectors(): JobConnector[] {
  return skillsWith('search').flatMap((skill): JobConnector[] => {
    if (!skill.source) return []
    const meta = CRAWL_META[skill.manifest.id] ?? {
      tier: 2 as const,
      markets: ['*'],
      needsSession: false,
      supports: { keyword: false, location: false },
    }
    return [
      {
        id: skill.manifest.id,
        ...meta,
        adapter: toDiscoveryAdapter(skill.source),
        ...(hasFirecrawl ? {} : { unavailableReason: 'Needs a Firecrawl key to read this site.' }),
      },
    ]
  })
}

export function allConnectors(): JobConnector[] {
  const fromSkills = skillConnectors()
  const skillIds = new Set(fromSkills.map((connector) => connector.id))
  return [
    ...SEARCH_CONNECTORS.map(({ meta, adapter }) => ({ ...meta, adapter })),
    // A skill's source wins over a legacy adapter with the same id.
    ...crawlConnectors().filter((connector) => !skillIds.has(connector.id)),
    ...fromSkills,
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
