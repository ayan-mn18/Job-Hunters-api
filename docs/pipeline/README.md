# The daily pipeline — design

Design for The Hunt: the 06:00 IST sweep that scrapes portals, scores postings,
tailors a resume per job description and applies, at 50–100 applications a day.

Nothing here is implemented yet. These documents fix the decisions and the
contracts so the backend can be written against them.

## Documents

| | |
| --- | --- |
| [01 — Queue and worker architecture](./01-queue-architecture.md) | Redis + BullMQ verdict, queue topology, pacing and daily budget, retries and idempotency, the live run log, 06:00 IST scheduling and catch-up |
| [02 — Resume tailoring and ATS score](./02-resume-engine.md) | Reading the base resume, the tailoring plan, where the fabrication line sits and how it is enforced, what ATS parsers break on, the rendering path, model choice and cost |
| [03 — Storage lifecycle](./03-storage-lifecycle.md) | What is kept forever vs regenerated, deterministic regeneration, retention, the cleanup job, storage math |
| [04 — The apply step](./04-apply-step.md) | Portal adapter seam, field mapping from My Kit, per-portal mechanism and risk picture |

## Contracts

TypeScript interfaces to code against. No implementation, no imports outside
this folder.

| | |
| --- | --- |
| [`contracts/pipeline.ts`](./contracts/pipeline.ts) | `PipelineJob`, queue names, `HuntRun`, `RunBudget`, `FailureClass`, `RunEvent`, `PortalLimits` |
| [`contracts/resume.ts`](./contracts/resume.ts) | `ResumeDocument`, `TailoringRequest`, `TailoringPlan`, `FabricationViolation`, `ResumeVariant`, `AtsReport` |
| [`contracts/apply.ts`](./contracts/apply.ts) | `KitAnswers`, `PortalAdapter`, `FieldMapping`, `ApplyOutcome`, `PortalCapabilities` |

## Experiment

[`experiments/`](./experiments/) — runnable. Renders the same `ResumeDocument`
as a single-column PDF and as a typical designer layout, parses both back, and
scores them the way an ATS would.

```bash
cd docs/pipeline/experiments && npm install && npm run experiment
```

Findings in [`experiments/RESULTS.md`](./experiments/RESULTS.md). Headline: the
single-column render passes 6/6 checks; the designer layout passes 3/6, losing
every section heading to `letter-spacing`, reordering Education ahead of
Experience via the sidebar, and duplicating the contact block via a running
page header. Keyword recovery — the metric most ATS-checker tools sell — was
10/10 on **both**, and is therefore the least useful signal in the set.

The same experiment shows the render is deterministic: two runs a second apart
differ in 4 bytes, all inside `/CreationDate`. That is what makes the storage
design possible.

## The decisions, in one page

**Queues.** Redis + BullMQ, yes — for delayed-job pacing, stalled-job recovery
and a timezone-aware scheduler. Five stages in six queue families, with scrape
and apply sharded per portal because BullMQ's rate limiter lives on the worker.
Redis holds work in flight; Postgres holds what happened. Write against
`upsertJobScheduler` — BullMQ 6 removed legacy repeatable jobs.

**Never apply twice.** Three layers: a dedupe key on the posting, a unique index
on `(user_id, job_id)`, and a deterministic BullMQ job id. The unique index is
the one that survives a Redis flush. The submit step writes an intent row before
the click and never auto-retries an ambiguous attempt.

**Live log.** SSE over a durable `run_events` table, with `Last-Event-ID`
resume. Not websockets (nothing flows upstream), not polling (idle most of the
time). Events are written to Postgres first, so a late connection replays the
run.

**Scheduling.** `pattern: '0 0 6 * * *'`, `tz: 'Asia/Kolkata'`. BullMQ does not
backfill missed runs, so a boot-time reconciler starts a `catchup` run with a
budget scaled to the remaining window — a worker that was down until 17:00 sends
20 applications, not 100.

**Resume storage.** Structured data is the source of truth; a PDF is a render.
Parse the upload once, have the user confirm it, never read a PDF again.

**Tailoring.** Reorder, select and reword real experience. Never manufacture it.
Enforced by a schema with no field for an invented employer, referential
validation on ids, numeric metric preservation, and an entity + semantic-drift
check — not by asking the model nicely.

**Rendering.** HTML → PDF via Playwright/Chromium, single column, standard
headings, no letter-spacing, no tables, no running headers. Every render is
parsed back and gated on an `AtsReport` before it can be uploaded. `.docx` as a
cheap second artifact from the same data.

**Model.** `claude-opus-5` for tailoring via the Message Batches API — the work
is known by 06:15 and the first submission slot is at 08:00, so nothing is
latency-sensitive and the batch discount is free money. ~$0.027 per tailoring
with prompt caching; ~$3.30/day all-in at 100 applications, with a spend cap
that pauses the run.

**Storage lifecycle.** Do not write rendered PDFs to Supabase Storage at all —
render on the worker, upload to the portal, delete. Keep the plan, the hashes,
the JD snapshot and the base version; regenerate the PDF on demand. That turns
2.1 GB/year of cold binaries into ~300 MB/year of queryable text.

**Applying.** One `PortalAdapter` interface over four very different mechanisms.
Concentrate volume on `ats_form` lanes reached by redirect — public forms, no
account at risk — and treat `browser_automation` on LinkedIn and Indeed as a
separate, per-portal decision with a much larger blast radius. A required field
below the confidence threshold is never guessed; the application parks for
review instead, because most screening questions are knockouts.
