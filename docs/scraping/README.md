# Job scraping — research findings

Research spike answering: *a cron runs daily at 06:00 IST, sweeps many job
portals, and must return only postings published in the last 24 hours. How do we
get that data, what do we use, and does it need browser automation?*

Everything here was verified by direct HTTP probe on **7 August 2026**. Re-probe
before trusting it later — these endpoints change constantly.

## Documents

- **[`portals.md`](./portals.md)** — portal-by-portal capability matrix. What
  each source actually exposes, whether it gives a real timestamp, what its
  terms and `robots.txt` say, and a ranking by freshness × legal safety ×
  implementation cost.
- **[`architecture.md`](./architecture.md)** — the recommended design. Browser
  automation verdict, library choices per tier, the 24-hour filter and timezone
  handling, dedupe, politeness and breakage detection, the `ScrapedJob` /
  `PortalAdapter` contracts, and the handoff to the BullMQ pipeline.
- **[`../../spikes/scraper/`](../../spikes/scraper/)** — runnable proof of
  concept. Three adapters, real network calls.

## The three answers

**1. Does it need browser automation? No.** Every source worth ingesting is a
plain HTTP `GET` returning JSON or RSS with an exact publish timestamp. The PoC
pulls 531 postings from three portals in under 5 seconds using only `undici`.
The portals that would need a browser — LinkedIn, Naukri, Wellfound, YC WaaS,
Bayt, GulfTalent — are the same ones that prohibit automation, sit behind
enterprise WAFs, or are reachable by a better route. Tier 3 stays empty. If it
ever isn't, use Playwright.

**2. What to build, in order.** Company ATS boards (Greenhouse / Ashby / Lever)
first — exact timestamps, first-hand data, and the only working route into the
Gulf. Then We Work Remotely (RSS) and RemoteOK (public JSON). Then the free
remote APIs (Remotive, Jobicy, Himalayas, Arbeitnow), and Adzuna for India.
All Tier 1, all unauthenticated, none carrying account-ban risk.

**3. The Gulf finding.** There is no Gulf equivalent of the RemoteOK API. Bayt
disallows its own `/en/jobs/` paths and 403s everything; GulfTalent returns
Akamai 403 on every path including `robots.txt`; NaukriGulf refuses the
connection; Dubizzle disallows `/api/`; Indeed's `robots.txt` explicitly
disallows `/jobs/AE/`, `/jobs/QA/`, `/jobs/KW/`; Adzuna has no UAE coverage at
all. **Go to the employers instead of the aggregators** — Careem, Tamara and the
all-remote global companies that staff Dubai and Riyadh all publish through
public ATS board APIs with exact timestamps. For someone targeting the Gulf with
experience but no visa, the all-remote global companies are the highest-value
segment, and they are the easiest to ingest.

## Proof-of-concept results

```
$ cd spikes/scraper && npm install && npm start

┌─ Job Hunters — scrape sweep
│  run at    7 Aug 2026, 11:36 pm IST  (2026-08-07T18:06:47.997Z)
│  window    last 24h, since 6 Aug 2026, 11:36 pm IST
│  adapters  remoteok, weworkremotely, gulf-ats
└─

RemoteOK                               tier 1  sanctioned          ok
   saw  100  →    0 inside 24h    859ms
We Work Remotely                       tier 1  sanctioned          ok
   saw  177  →   11 inside 24h  █  3891ms
Gulf employers (Greenhouse + Ashby boards) tier 1  sanctioned      ok
   saw  254  →    6 inside 24h  █  3060ms

TOTALS
  seen across all portals   531
  inside the 24h window     17
  after cross-portal dedupe 16  (collapsed 1)
  timestamp precision       exact=16
  Gulf-located              2
```

Widening to 48 hours exercises all three adapters:

```
$ npm start -- --hours 48

RemoteOK              saw 100 →  17 inside 48h
We Work Remotely      saw 177 →  21 inside 48h
Gulf employers        saw 254 →  14 inside 48h

  seen across all portals   531
  inside the 48h window     52
  after cross-portal dedupe 50  (collapsed 2)
  timestamp precision       exact=50
```

**Every surviving job carried an exact timestamp** — no relative-string guessing
was needed anywhere in the Tier 1 set.

**RemoteOK's zero at 24h is real, not a bug.** Its API's newest posting was 24.5
hours old at probe time; the whole feed spanned 5–6 August with nothing from the
7th. Feeds lag. `architecture.md` recommends sweeping a 26–30 hour window and
relying on a unique constraint on `(portal, source_id)` rather than letting the
freshness window be the only thing preventing duplicates.

**Real Gulf output**, from Tamara's Greenhouse board:

```
2026-08-07T05:40:31.000Z  [exact]  gulf-ats
Money Laundering Reporting Officer  @  Tamara
Dubai, United Arab Emirates  ·  onsite  ·  fp=e757104e47d86228
https://job-boards.eu.greenhouse.io/tamara/jobs/4942167101
```

**Dedupe verified working**: it correctly collapsed *"Associate Solutions
Architect (French or German fluency)"* at GitLab — posted to a Spain board and an
Ireland board three seconds apart — into a single job.

## Bugs the run caught that writing alone would not have

`fast-xml-parser`'s billion-laughs guard defaults to `maxTotalExpansions: 1000`.
We Work Remotely embeds full HTML job descriptions as escaped entities — roughly
1,100 per feed — so **every WWR feed threw and the adapter returned zero jobs**,
logging a warning that a less careful runner would have ignored. A scraper
returning zero looks exactly like a quiet day. Raising the ceiling (without
disabling the guard) took WWR from 0 to 11 fresh jobs.

That single failure is the argument for the monitoring design in
`architecture.md`: **alert on zero-jobs-from-a-normally-nonzero-source**, because
silence is how scrapers fail.
