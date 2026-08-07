# Scraper spike

Throwaway proof of concept for the daily job sweep. Answers one question: can we
pull many portals and keep only the last 24 hours, without a browser?

Yes. See [`../../docs/scraping/`](../../docs/scraping/) for the full findings.

## Run it

```bash
npm install
npm start                    # last 24h, all adapters
npm start -- --hours 48      # widen the window
npm start -- --portal remoteok
npm start -- --json          # dump normalised jobs
npm run typecheck
```

Requires Node 22+. Makes real network calls to public endpoints — no auth, no
accounts, no credentials anywhere.

## What's here

| File | Purpose |
| --- | --- |
| `src/types.ts` | `ScrapedJob` and `PortalAdapter` — the two contracts |
| `src/http.ts` | Polite `undici` client: per-host rate limit, backoff + jitter, conditional GET |
| `src/freshness.ts` | The 24h filter — interval-based, UTC-only, IST-aware at the edges |
| `src/normalise.ts` | Location parsing, title/company canonicalisation, cross-portal dedupe |
| `src/adapters/remoteok.ts` | Public JSON API, exact `epoch` |
| `src/adapters/weworkremotely.ts` | RSS feeds, exact `pubDate` |
| `src/adapters/gulf-ats.ts` | Greenhouse + Ashby boards for Gulf employers |
| `src/run.ts` | CLI runner — stands in for the BullMQ worker |

## Adding an adapter

Export one `PortalAdapter` from `src/adapters/`, add it to `ADAPTERS` in
`run.ts`. Nothing else changes. Set `tier` and `legal` honestly — the runner
prints them, so the compliance posture shows up in every run and in every diff.

## Not production code

In-memory conditional-GET cache (needs Redis), no first-seen store for
timestamp-less portals, and the Gulf employer registry has three verified
entries rather than a comprehensive list. `normaliseLocations` also does not
split comma-separated country lists, so WWR's multi-country `region` strings are
lossy. Promote to `src/scraping/` and fix those before relying on it.
