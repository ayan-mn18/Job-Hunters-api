# Deployment

Huntly runs as **three processes** from one codebase. They share a database,
a Redis, and an object store, and nothing else.

| Process | Entry | Image | Scales on |
|---|---|---|---|
| `api` | `dist/index.js` | `Dockerfile.api` | Request throughput |
| `worker` | `dist/worker.js` | `Dockerfile.worker` | Queue depth |
| `runner` | `dist/runner.js` | `Dockerfile.runner` | Memory (~300–500 MB per live browser) |

```bash
docker compose up --build
```

Postgres is deliberately not in the compose file: the project runs against
Supabase, and pointing local development at a different database than
production is how schema drift starts.

## Why three

The API used to do all of it. Three couplings made that undeployable:

- Browser automation resolved Chromium to `/Applications/Google Chrome.app`,
  which is correct on exactly one machine.
- The daily LinkedIn sweep was a `setInterval` inside the web process. Two
  replicas meant two sweeps; a restart meant none.
- Discovery ran as `void discoverForRun(...)` inside the POST handler — a
  promise nobody held, on a process that restarts on every deploy.

Splitting them draws the line where the operational properties actually
differ. The API is stateless and must answer immediately. Queue work must
survive a restart. Browser work needs a 1.5 GB image and different scaling
economics from everything else.

## Scheduling

There is no scheduler process. Daily work is registered as BullMQ **job
schedulers**, keyed `daily-<queue>-<userId>` and read from the `user_schedules`
table at worker boot. Scheduler ids are deterministic, so every replica can
register the same schedule and exactly one fires — which is what makes a
fourth process unnecessary.

Each user picks their own hour in their own timezone. Verify what is
registered:

```bash
redis-cli zrange bull:huntly-discover:repeat 0 -1
```

## Redis

Use a **real Redis instance**, not a per-request serverless one. BullMQ polls
continuously; during development here, ordinary queue traffic exhausted an
Upstash free tier's 500,000-request allowance. Queue state also matters —
`docker compose` runs Redis with `appendonly yes` so a restart does not drop
every scheduled job and queued application.

Redis holds three things: the queues, the daily schedulers, and the
distributed locks.

## Locks

`withUserResourceLock(userId, resource, fn)` holds one invariant: **one live
browser session per user per resource, ever.** Two tabs driving the same
LinkedIn account is both a correctness bug and the fastest way to look like
automation to a portal.

The lock has a 60-second TTL and is renewed on a heartbeat while the work runs.
The short TTL is deliberate and was learned the hard way: with a fixed
15-minute TTL, a worker killed mid-scrape locked that user out of their own
discovery for the rest of the quarter hour. The TTL is not a ceiling on how
long work may take — it is how long a *dead* holder blocks everyone else.

## Recovering interrupted runs

A restart mid-discovery leaves a `hunt_runs` row in `running`. Two mechanisms
bring it back:

1. **BullMQ stalled-job detection.** A backstop. It depends on lock expiry and
   check intervals lining up, and it cannot be relied on alone — in testing, a
   job sat in `active` with no worker and no lock without being reclaimed.
2. **The reconcile sweep.** A repeatable job on the discover queue, every five
   minutes, that finds runs stuck in `queued`/`running` for more than three
   minutes, confirms nobody holds that user's discovery lock, and re-queues
   them. This is the guarantee; the lock check is what stops it from
   interrupting a scrape that is merely slow.

It also runs once at worker boot.

## Connection pools

`DATABASE_POOL_MAX` is **per process**, and there are now three of them.

The Supabase session pooler on this project allows **15 connections in total**.
Three services at the default 10 ask for 30, and the third one to warm up
starts failing outright:

```
(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15
```

Compose therefore sets them explicitly — api 6, worker 4, runner 3 — which
totals 13 and leaves room for a migration or a script. Budget the total against
the pooler's limit rather than setting one number everywhere, and remember that
each *replica* counts: two API replicas at 6 is 12 on their own.

The runner needs the fewest. Its work is browser-bound, not query-bound.

## Where the latency actually is

Measured from the development machine (India) against Supabase in
`ap-southeast-2` (Sydney):

| | |
|---|---|
| App overhead (`/healthz`, no database) | ~1.5 ms |
| One database round trip | **~137 ms** |
| bcrypt at cost 12 (`@node-rs/bcrypt`) | ~207 ms |
| `POST /auth/login` end to end | ~490 ms |

Login is two queries plus one hash: 137 + 207 + 137 ≈ 481 ms, which is what it
measures. Swapping `bcryptjs` for the native implementation took roughly
600–1200 ms down to this, and that is as far as hashing can take it.

The remaining ~275 ms is two round trips to Sydney, and **every** endpoint pays
that per query — discovery, which runs many, pays it repeatedly. Moving the
Supabase project to a region near the users (`ap-south-1`) is worth more than
any further application-level tuning. Dropping `BCRYPT_ROUNDS` to 10 would save
~150 ms on auth alone, at the cost of a four-fold weaker hash; prefer the
region move.

## Browsers

`playwright-core` ships no browser. The runner image installs a matching one
and `BROWSER_IN_CONTAINER=true` adds the flags Chromium needs to survive a
container (`--no-sandbox`, `--disable-dev-shm-usage`). Leave
`CHROMIUM_EXECUTABLE_PATH` empty there — Playwright resolves its own browser,
and hardcoding the path pins a build number that changes on every version bump.

The base image tag in `Dockerfile.runner` must match the installed
`playwright-core` version. Bump both in the same commit.

Interactive sign-in (`AUTOMATION_HEADFUL=true`) opens a real window and so only
works on a machine with a display. Connecting a LinkedIn account on a deployed
host needs the live-view work — until then, connect locally.

## Secrets

`PORTAL_CREDENTIALS_KEY` is a **master key**. It does not encrypt credentials
directly; it wraps a per-user data key stored in `user_keys`, and credentials
are encrypted under that. Rotating the master key therefore re-wraps one small
table instead of re-encrypting every secret in the database, and one user's
compromise stops at that user.

Credentials written before this change (`v: 1` envelopes) are sealed under the
master key directly and still decrypt. Nothing new is written that way.

Move every value out of `.env` and into the platform's secret store before
deploying, and rotate `PORTAL_CREDENTIALS_KEY` and both JWT secrets as part of
the first deploy.

## Model cost

Every model call is metered into `model_usage` with tokens and dollars. This
exists from the first call rather than after pricing is settled — retrofitting
cost accounting to a flat-fee product is how the fee quietly stops covering it.

`MODEL_MONTHLY_BUDGET_USD` caps per-user spend; `0` disables the check. Without
`ANTHROPIC_API_KEY`, model-backed features fall back to deterministic
behaviour rather than failing.
