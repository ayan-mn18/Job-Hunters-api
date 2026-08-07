# 1 — Queue and worker architecture

Contracts: [`contracts/pipeline.ts`](./contracts/pipeline.ts)

## Verdict on Redis + BullMQ

**Use it.** It is the right choice here, and the reasons are specific rather than
"it's popular":

- The pipeline is a **fan-out with a hard pacing requirement**. 100 applications
  a day spread over ~11 hours is one submission every ~7 minutes, per portal,
  with jitter. Delayed jobs and per-worker rate limiters are BullMQ's core
  competence. Rebuilding delayed-set semantics on top of a Postgres queue is
  where most homegrown schedulers go wrong.
- **Stalled-job recovery is built in.** A worker that dies mid-tailor gets its
  lock expired and the job re-delivered. That behaviour is the difference between
  "the run resumes" and "the run silently loses 40 jobs".
- **Job Schedulers give a real cron with a timezone**, which is the 06:00 IST
  requirement almost verbatim.
- You are already running Redis for caching and session state. One more
  dependency is one too many; zero more is right.

Three pushbacks, because "use BullMQ" is not the whole answer:

1. **Do not put the pipeline state in Redis.** Redis holds *work in flight*.
   Postgres holds *what happened*. Every claim the UI makes ("68 applied today",
   "which resume went to this job") must be answerable with Redis flushed. This
   matters more than the queue choice — it is what makes a mid-run crash boring.
2. **Do not use one queue with a `type` discriminator.** The five stages have
   nothing in common operationally: scraping is network-bound and per-portal
   throttled, scoring is cheap and cacheable, tailoring is expensive and
   cost-capped, applying is slow, rate-limited and irreversible. One queue means
   one concurrency number and one retry policy for all of them, and a portal
   outage backs up your LLM workers.
3. **Do not reach for BullMQ Flows.** Flows model a fixed parent/child tree
   known at enqueue time. This fan-out is dynamic (one scrape produces 0–400
   postings, of which an unknown subset survives dedupe and scoring) and the
   stages are not a tree — several postings collapse into one JD analysis. Plain
   queues chained by the producing worker are simpler and easier to resume.

Version note: **BullMQ 6.0.0 (2026-07-30) removed legacy repeatable jobs** —
`repeat` on `Queue#add`, the `Repeat` class, `getRepeatableJobs()`,
`removeRepeatable()`. Write against `upsertJobScheduler` from day one.
`debounce`/`debounceId` are likewise gone, replaced by `deduplication` /
`deduplicationId`.
([changelog](https://docs.bullmq.io/changelog),
[job schedulers](https://docs.bullmq.io/guide/job-schedulers/),
[deduplication](https://docs.bullmq.io/patterns/deduplication))

## Topology

```
                    Job Scheduler  (cron "0 0 6 * * *", tz Asia/Kolkata)
                                 │
                                 ▼
                        create HuntRun row
                                 │
        ┌──────────────┬─────────┴─────────┬──────────────┐
        ▼              ▼                   ▼              ▼
 hunt.scrape:linkedin  hunt.scrape:naukri  …  one lane per connected portal
        └──────────────┴─────────┬─────────┴──────────────┘
                                 ▼
                          hunt.triage            dedupe, persist job + JD snapshot
                                 │
                                 ▼
                          hunt.score             deterministic score + cached JD analysis
                                 │  (>= minMatchScore)
                                 ▼
                          hunt.tailor            LLM plan → validate → render → ATS gate
                                 │
        ┌──────────────┬─────────┴─────────┬──────────────┐
        ▼              ▼                   ▼              ▼
 hunt.apply:linkedin   hunt.apply:naukri   …  one lane per portal, delayed + jittered
                                 │
                                 ▼
                            hunt.dead          anything that exhausted its policy
```

Five logical stages, six queue families. Scrape and apply are **sharded per
portal** because BullMQ's rate limiter lives on the `Worker`, not on a job
group — the only way to pace LinkedIn independently of RemoteOK in the OSS
build is a queue per portal with its own worker and limiter. This also means a
portal in cooldown or with an expired session stalls exactly one lane.

### Worker settings

| Queue | Concurrency | Limiter | Attempts | Backoff | Notes |
| --- | --- | --- | --- | --- | --- |
| `hunt.scrape:<portal>` | 1–2 | per-portal, e.g. 20/min | 3 | exponential, 30s base | Serial per portal; parallel scraping is what gets sessions flagged |
| `hunt.triage` | 4 | — | 3 | exponential, 5s | Pure DB work |
| `hunt.score` | 8 | LLM: 20/min | 3 | exponential, 10s | JD analysis cached by `jdHash`; most jobs never call the model |
| `hunt.tailor` | 4 | LLM: 30/min | 2 | exponential, 20s | Renderer is the memory hog, not the model |
| `hunt.apply:<portal>` | **1** | per-portal `PortalLimits` | **1** *(see below)* | — | Never parallel within a portal |

`hunt.apply` concurrency is 1 per portal and lives on its own worker process.
Two browser sessions against the same account from the same IP is the single
most reliable way to get flagged.

## Pacing, throttling and the daily budget

Three independent mechanisms, because each one fails differently.

**1. Scheduled dispatch.** At the end of `hunt.tailor`, the apply job is
enqueued with a computed `delay`, not immediately:

```
window     = spec.submitWindow          // default 07:00–18:00 IST
slot(n)    = windowStart + n * (windowLength / dailyTarget)
delay      = slot(n) + jitter(-90s, +90s) - now
```

This spreads the day's submissions evenly by construction. Jitter is
deliberately asymmetric-free and coarse — human-plausible spacing, not a
disguise. If a run starts late (a catch-up run at 11:00), the window shrinks and
the slot spacing tightens automatically, up to the per-portal floor.

**2. Per-portal limiter.** `PortalLimits` on the worker is the backstop for
anything that bypasses slot maths — retries, catch-up bursts, a manual "run
now". It also carries `cooldownMs`, applied to the whole lane when the adapter
reports `rate_limited`, and `dailyCap`, which is a hard ceiling the user's
target cannot override. If the user asks for 100/day across 3 portals and one
portal's cap is 15, the run submits 15 there and reallocates the rest.

**3. Budget accounting.** `RunBudget` is snapshotted at run start and enforced
at three checkpoints:

- Before a tailoring call: `counters.tailored < budget.tailoringCap` and
  `counters.llmSpendUsd < budget.llmSpendCapUsd`. The cap is
  `dailyTarget × 1.3` because some plans get rejected by the fabrication
  validator and some renders get rejected by the ATS gate.
- Before a submit: `counters.submitted < budget.applicationsTarget`.
- On every counter update, via a single atomic Redis `INCR` per counter, with
  Postgres reconciled asynchronously. The Redis counter is the fast gate; the
  Postgres unique constraint is the actual guarantee.

Hitting a cap **pauses** the run (`status: 'paused'`), it does not fail it.
Remaining apply jobs stay delayed and are cancelled by the next day's run when
it sees a stale `runId`.

## Retries, backoff and idempotency

### Retry policy is chosen from the failure class, not the exception

`FailureClass` in the contracts is the whole policy table. The important
choices:

- **Unclassified failures are `permanent`.** Retrying an unknown error five
  times against a portal that might be soft-blocking you is worse than
  dead-lettering it and asking a human. The default in most queue code is the
  opposite, and it is wrong for this workload.
- **`captcha` and `auth_expired` never retry.** They pause the portal lane and
  raise a `RunEvent` the UI surfaces on the Hunt screen. A retry loop against a
  captcha wall is how an account gets banned rather than merely throttled.
- **`form_changed` dead-letters immediately.** A selector miss means the adapter
  is out of date; retrying it produces a half-filled form, which is worse than
  no application.
- **`rate_limited` retries once after `cooldownMs`, and slows the lane** for the
  rest of the run.

Backoff is exponential with full jitter. Attempts are low everywhere (2–3, and
**1 for apply**) because this is a daily batch — a job that fails today is a
perfectly good candidate for tomorrow's run, and tomorrow is cheaper than a
retry storm.

### Never apply twice — three layers

```
1. jobs.dedupe_key         UNIQUE   sha256(company|title|jdHash)
2. applications(user_id, job_id)  UNIQUE
3. BullMQ jobId = `apply:${userId}:${jobId}`
```

Layer 3 makes a duplicated *enqueue* a no-op. Layer 2 makes a duplicated
*submission* impossible, and it is the one that survives a Redis flush, a
BullMQ upgrade, or a bug in layer 3. Layer 1 collapses the same posting seen on
LinkedIn and Indeed into one job — worth having because cross-posting is the
norm and applying twice through two portals looks worse than not applying at all.

Note what is *not* used for dedupe: the portal's own job id. Those are portal-
scoped and cross-posted roles have different ids everywhere. Hashing
`company|title|jdHash` catches the real duplicate.

### The dangerous window, and how it is closed

The one place where "at least once" is not good enough is between clicking
submit and recording that we did. A worker killed in that window leaves no
trace, and a retry double-applies.

The fix is an **intent log written before the side effect**:

```
BEGIN
  INSERT INTO apply_attempts (application_id, state, started_at)
  VALUES ($1, 'submitting', now())          -- one row per attempt
COMMIT
→ adapter.submit(...)
→ UPDATE apply_attempts SET state='submitted', external_id=$2 …
```

On worker boot, any `submitting` row older than the adapter timeout is moved to
`unknown` — **never retried**. It is resolved by, in order: the adapter's
`pollStatus` if the portal has one; otherwise the "already applied" signal on
the next discovery pass; otherwise it sits in the Applications list marked
`needs_review` for the user to confirm. Leaving a handful of ambiguous rows for
a human is strictly better than a duplicate submission.

### What happens when a run is interrupted halfway

| Failure | Behaviour |
| --- | --- |
| Worker crashes mid-job | BullMQ lock expires (`lockDuration` 60s, `maxStalledCount` 1), job is re-delivered to another worker. Safe for scrape/triage/score/tailor — all pure functions over persisted inputs. |
| Worker crashes mid-**apply** | Intent log above. No automatic retry. |
| Whole service restarts | Delayed apply jobs survive in Redis. On boot, reconcile: for each `running` run, recompute counters from Postgres, expire jobs whose `runId` is not today's, resume. |
| Redis lost entirely | Runs marked `running` with no queue backing are marked `failed` on boot; today's run is re-derivable from Postgres and can be restarted with the already-submitted set excluded by the unique index. Nothing double-applies. |
| User clicks "Call Hunty back" | `runs.status = 'stopped'`. Every worker checks run status at job start and returns early; delayed apply jobs are removed by `runId`. No queue draining needed — the flag is the kill switch. |

## Observability: what the live run log streams, and how

**Decision: SSE, from Postgres, with `Last-Event-ID` resume.** Not websockets,
not polling.

Why: the run log is strictly server → client. The control channel (start, stop,
edit spec) is already REST and stays REST. `EventSource` gives reconnection and
event-id resumption for free, survives proxies that mishandle websocket
upgrades, and needs no sticky sessions. A websocket buys bidirectionality this
feature does not use, and costs a stateful connection layer. Polling at the
2–5s cadence a "live" log implies is 20k+ requests/day/user for data that is
idle most of the time.

`GET /hunt/runs/:id/stream` emits `RunStreamMessage`:

- `event` — one `RunEvent` per meaningful action. Already the shape the UI
  renders in `mock.ts::activity` (emoji + human sentence + relative time):
  `🔎 Scraped 138 new jobs from RemoteOK`, `✂️ Tailored resume for Pastel Pay JD`,
  `📮 Applied to Platform Engineer at Otterly`, `⏸️ Naukri cooling down for 12m`.
- `progress` — throttled to ~1/s, carries `RunCounters` plus per-portal lane
  state. This drives the progress bar and the portal list, so the UI never has to
  aggregate events itself.
- `heartbeat` — every 20s, so a dead connection is detectable and proxies don't
  idle-close.

Two rules that make this reliable:

1. **Events are written to Postgres first, then published to Redis pub/sub, then
   fanned out to SSE.** The stream is a view over a durable table, so refreshing
   the page or connecting late replays the run from `seq = 0`. A log that only
   exists in memory is the thing users notice is broken.
2. **Events are for humans; metrics are separate.** No stack traces, no job ids
   in the message text. Machine detail goes in `refs` and in the dead-letter
   record. If a stage fails, the user sees "Naukri session expired — reconnect
   to keep hunting", and the engineer sees the `DeadJob`.

The Applications screen stays on plain REST with polling — it is a table of
finished work, and SSE there would be complexity for no user-visible gain.

## Scheduling at 06:00 IST

```ts
await queue.upsertJobScheduler(
  `daily:${userId}`,
  { pattern: '0 0 6 * * *', tz: 'Asia/Kolkata' },
  { name: 'start-run', data: { userId }, opts: { attempts: 1 } },
)
```

Notes that matter:

- **Name the IANA zone, do not hardcode 00:30 UTC.** India has no DST today, so
  the two are equivalent *right now* — which is exactly why hardcoding is
  tempting and wrong. The zone is a user setting; the moment someone in a DST
  zone uses this, `Asia/Kolkata` scales and `00:30 UTC` silently drifts an hour
  twice a year. The cost of doing it right is zero.
- **`upsertJobScheduler` is idempotent by `schedulerId`.** Call it on every boot
  and on every spec change. Deleting the user or disabling the hunt removes the
  scheduler by the same id.
- One scheduler per user, not one global scheduler that loops users. Per-user
  schedulers let one user's run pause without touching anyone else's, and make
  the "next run at" the UI shows a single lookup.

### If the worker was down at 06:00

**BullMQ will not backfill.** Its scheduler "only generates new jobs when the
last job begins processing", so a worker that is down does not accumulate missed
runs — it produces one late job when it comes back, or none. Do not design
around BullMQ's recovery here; design your own.

On worker boot, and every 15 minutes thereafter, a reconciler runs:

```
todayIST = current calendar date in Asia/Kolkata
if no hunt_runs row for (userId, todayIST) and hunt is enabled:
    if nowIST < catchupCutoff (default 20:00):
        start a run with trigger='catchup'
        scale budget:  target × (remainingWindow / fullWindow), floor 20%
        emit RunEvent: "⏰ Missed the 06:00 start — running a shorter hunt now"
    else:
        emit RunEvent: "😴 Missed today's hunt. Back at 06:00 tomorrow."
        record a skipped run so the streak counter and the UI both stay honest
```

The scaled budget is the point. A worker that was down until 17:00 should not
fire 100 applications into a two-hour window — that pattern is what portals
detect. Better to send 20 and log why.

The reconciler is also what makes the run row idempotent: the `(userId,
runDate)` unique constraint means the scheduler firing and the reconciler racing
produces one run, not two.
