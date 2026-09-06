# Adding a job source

The smallest useful contribution to this codebase. A source implements one
method; everything after that — freshness, the role gate, detail fetching,
politeness, deduplication, scoring — is shared, so no source can quietly skip
it.

## The two kinds

**Crawl sources** list whatever is recent and ignore the query plan: an
employer's ATS board, a remote-jobs feed. `supports.keyword` is false.

**Search sources** take keywords and a market and issue one request per query.
`supports.keyword` is true. These are the ones that can act on what the user
asked for, and they are always included in a run when configured — a user
should not have to tick a box to have their own search run.

## The minimum

```ts
// src/hunt/discovery/connectors/example.ts
import type { SourceAdapter } from '../runner.js'
import type { ConnectorMeta } from '../connector.js'

export const exampleMeta: ConnectorMeta = {
  id: 'example',
  tier: 1,                       // 1 licensed search · 2 employer ATS · 3 session
  markets: ['IN', 'AE', 'remote'],
  needsSession: false,
  supports: { keyword: true, location: true },
  // Set this when a required key is missing. Name the key — a source that is
  // silently absent is indistinguishable from one that found nothing.
  ...(process.env.EXAMPLE_API_KEY
    ? {}
    : { unavailableReason: 'Set EXAMPLE_API_KEY to search Example.' }),
}

export const exampleSource: SourceAdapter = {
  id: 'example',
  label: 'Example',
  detailConcurrency: 2,

  async list(context) {
    const stubs = []
    for (const query of context.queries ?? []) {
      // ... fetch, map to JobStub ...
      await recordSearchQuery({
        runId: context.runId,
        connectorId: 'example',
        query: query.keywords,
        market: query.market,
        resultCount: found.length,
        durationMs: Date.now() - startedAt,
      })
    }
    return { stubs, seen: stubs.length, warnings: [] }
  },
}
```

Register it in `src/hunt/discovery/registry.ts`, and add a row to
`PORTAL_CATALOGUE` in `src/db/portal-catalogue.ts` if it should appear in the
portal picker.

## Rules that are not negotiable

**Use the shared fetcher.** `fetchJson` / `request` from `./fetcher.js` carry
the per-host rate limiter, retry policy, timeouts and robots handling. A raw
`fetch` bypasses all of it and will eventually get the whole product blocked
from a host somebody else depends on.

**Never invent a date.** If the source does not publish a timestamp, set
`postedAtPrecision: 'first-seen'`. Guessing puts stale postings at the top of
someone's list.

**Never invent a salary.** If the source marks a figure as estimated, drop it.
A guessed number shown as though the employer stated it is worse than no
number — people make decisions on these.

**Record every query.** `recordSearchQuery` is what makes "why didn't I see the
job at X?" answerable. Without it, "never searched", "searched and found
nothing" and "found it but scored it low" all look identical.

**Fail one query, not the run.** Catch per query, push a warning, keep going.

**Prefer an apply URL.** If the source exposes a direct ATS link, put it in
`applyUrl`. Cross-source merging keeps whichever copy can actually be applied
through, and an aggregator's redirect is usually a dead end for the apply
runtime.

## Tier 3, and why it is different

A tier-3 source uses the user's own logged-in session. It is the only kind that
can get a *user's* account restricted rather than costing the server a request,
so it is opt-in, off by default, and rate-limited far below what the platform
would technically allow.

If you are adding one, read [outreach.md](outreach.md) first — not because it
is about the same feature, but because it is where the reasoning about that
risk is written down.

## Checklist

- [ ] `ConnectorMeta` with honest `markets` and a named `unavailableReason`
- [ ] Registered in `registry.ts`
- [ ] Uses the shared fetcher
- [ ] `recordSearchQuery` on both success and failure
- [ ] No invented dates or salaries
- [ ] A test that does not touch the network
