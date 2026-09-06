# Job Hunters — API

Backend for [Job-Hunters-UI](https://github.com/ayan-mn18/Job-Hunters-UI). It
finds jobs worth applying to, applies to them, chases referrals, and reads the
replies.

## Running it

```bash
cp .env.example .env      # fill in DATABASE_URL and the JWT secrets at minimum
npm install
npm run db:migrate
docker compose up --build
```

Three processes, one codebase. See [docs/deployment.md](docs/deployment.md).

| Process | Entry | What it does |
|---|---|---|
| `api` | `npm run dev` | HTTP only. Never launches a browser, never runs a job. |
| `worker` | `npm run worker:dev` | Discovery, ranking, inbox, schedules. No browser. |
| `runner` | `npm run runner:dev` | Everything needing a browser: applying, LinkedIn, outreach. |

Browsers are hosted by default (`BROWSER_PROVIDER=browser-use`) and driven over
CDP by this project's own Playwright code, so the runner image no longer needs
Chromium of its own. Muse Spark reasons everywhere; Firecrawl reads every page
that needs no login.

## What it does

**Discovery** — [docs/discovery.md](docs/discovery.md)
Turns the user's roles and locations into actual searches, across licensed
search APIs and employer ATS boards, then ranks twice: a deterministic scorer
over everything, and a model reading the shortlist.

**Intake** — [docs/intake.md](docs/intake.md)
Seeds a persona from the résumé, then asks only questions whose answers
change which jobs the user sees. Median five questions, hard cap seven.

**Applying** — [docs/apply.md](docs/apply.md)
A state machine per attempt, watchable live over a WebSocket, with takeover
when it gets stuck. Portal recipes first, heuristics second, a model last —
and every answer it learns is cached so the next person never waits for it.

**Site skills** — [docs/skills.md](docs/skills.md)
Everything known about one website — where it may navigate, whether it needs a
signed-in profile, how to list its postings, how to complete its application —
in one directory. Adding a site is adding a directory.

**Referrals, inbound** — [docs/referrals.md](docs/referrals.md)
Sweeps the user's LinkedIn threads for people asking *them* for a referral,
classifies at thread level, and drafts a reply grounded in the résumé.

**Referrals, outbound** — [docs/outreach.md](docs/outreach.md)
Name a company; it finds people there who could refer you, ranks them, writes
the ask, and sends it at human pace **only after the user approves the words**.
Read that document before touching this module.

**Inbox** — [docs/inbox.md](docs/inbox.md)
Reads replies from Gmail, classifies them, links them back to the application
they belong to, and surfaces the ones that need a human today.

## What needs a key

Everything degrades honestly: a missing key disables a feature and says which
key would enable it, rather than failing a run.

| Key | Without it |
|---|---|
| `JSEARCH_API_KEY` or `SERPAPI_KEY` | No keyword search. Discovery can only crawl company boards — it cannot act on the user's roles or locations. **This is the one that matters most.** |
| `ADZUNA_APP_ID` / `_KEY`, `JOOBLE_API_KEY` | Less breadth; no Gulf coverage. |
| `ANTHROPIC_API_KEY` | No semantic rerank, no classification, no drafts. Deterministic behaviour throughout. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | No inbox. |
| `PORTAL_CREDENTIALS_KEY` | No stored sessions, so no LinkedIn features. |

## Safety posture

Three things are off by default and stay off until a user turns them on:
browser automation (`PORTAL_AUTOMATION_ENABLED`), the inbox, and outbound
outreach.

Outbound outreach in particular can get a user's LinkedIn account restricted.
Its rails live in `src/outreach/limits.ts`, which every send path imports rather
than re-checking, and nothing sends without an explicit approval row. The
reasoning is in [docs/outreach.md](docs/outreach.md); read it before changing
any number in that file.

## Adding a job source

The most likely outside contribution, and the smallest interface in the
codebase: see [docs/adding-a-source.md](docs/adding-a-source.md).

## Development

```bash
npm test          # 198 tests, no network
npm run typecheck
npm run db:generate   # after editing src/db/schema.ts
npm run skills:check  # every site skill's manifest and playbook
```

Tests never touch the network or a real browser. Anything that would is behind
an interface with a deterministic fallback.

These four do use the network, and cost a little, so they are run by hand:

```bash
npm run browser:verify              # opens a hosted browser and proves it stops
npm run skills:source workatastartup 5   # runs one skill's source for real
npm run agent:verify <apply-url>    # drives a real form, dry run, submits nothing
npm run apply:dry-run <email>       # the deterministic ladder against live ATS forms
```
