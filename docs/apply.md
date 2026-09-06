# Applying

**Dry run is the default.** Filling a form is reversible; submitting it is not.
`APPLY_DRY_RUN=true` fills every field, screenshots the result, and stops
before the submit click. Turning it off is what makes the product send real
applications to real employers on someone's behalf, and that should be a
deliberate act rather than a default anyone inherits.

`APPLY_KILL_SWITCH=true` stops every submission immediately, without a
redeploy. Both are checked immediately before the click, in one place, so no
later code path can route around them.

## States, not a straight line

The old function ran fill → submit → hope. When it stopped somewhere it wrote
`needs_review` and nothing else, so a user learned their application had failed
and could learn nothing further.

```
queued → opening → filling → submitting → submitted
                      ↓            ↓
                   blocked       failed
                      ↓
                   skipped   (dry run / kill switch — a success, not a failure)
```

Every transition is written to `attempt_events` with a reason, and published
per user over Redis so the API process can forward it to a browser. `blocked`
carries *why*: `needs_input`, `captcha`, `login_required`, `unknown_field`,
`sensitive_field`. Each needs a different response from a person.

A dry run ends in `skipped`, not `failed`. Recording it as an error would make
the safe mode look broken and push people to turn it off.

## The field ladder

Filling a field is trivial. Knowing *which* field is which is the whole
problem: every form invents its own phrasing for the same handful of questions.

1. **Recipe** — per-portal knowledge for Greenhouse, Lever and Ashby.
2. **Cache** — `field_answers`, keyed by `(host, field signature)`.
3. **Heuristic** — label patterns, the whole of the old implementation.
4. **Model** — asks what an unfamiliar field wants, then caches the mapping.

The cache is the compounding asset. A strange question any user meets is
answered once and answered instantly forever after. A null `userId` marks the
shared layer: it stores the *mapping* from a question to a known field, never
anyone's value.

Heuristics are skipped on labels over 80 characters. Above that a label is a
question, not a field name — and a live GitLab form proved why, by matching
"current employer" inside *"Are you subject to any employment agreements
and/or restrictive covenants with your current employer?"*.

## The agent tier

The ladder handles the forms it knows: Greenhouse filled 23 fields in seconds
for nothing. The agent exists for what the ladder cannot reach at all — an
aggregator listing with no form on it, a portal with no recipe, a multi-step
flow that needs a link followed before a form appears. It runs *after* the
ladder, never instead of it, and a failed agent never loses the ladder's work.

Muse Spark decides each step and Playwright performs it (`src/agent/`). One
observation, one tool call, one action, repeat — bounded per step and overall.
An earlier version handed the model a paragraph-long goal and asked it to plan;
it sat inside a single call for over half an hour on a live run.

What the model sees is text, not pictures: every interactive element, numbered,
with the label a person would read. A screenshot is thousands of tokens and a
form is a few hundred, so images are attached only when the element list is
empty or the last action changed nothing. Numbering is stamped into the DOM
(`data-huntly-ref`) and re-stamped every observation, because between observing
and acting the page may have re-rendered.

Three rules are enforced in `src/agent/tools.ts`, on the arguments the model
actually passed, rather than asked for in a prompt:

- navigation is confined to the skill's `allowedDomains`, and a click that
  lands off them goes back;
- every write is checked against the same never-auto list below;
- in a dry run the submit tool is **absent from the tool list**, and refused
  again in the executor if the model invents it.

This replaced Stagehand, which could only reason with providers on its own
list, needed a browser extension Chromium would not load headlessly — so it ran
a second, invisible browser and the live view went dark for the whole agent
phase — and bundled a zod major version this project does not use.

Site-specific behaviour lives in a site skill rather than here. See
[skills.md](skills.md).

## What is never answered

Demographics, salary expectations, visa status, criminal history, references'
contact details, and legal questions about existing obligations. Not a
capability gap — a decision. Getting one of these wrong on someone's
application is not a bug you can apologise for afterwards, and a plausible
guess is worse than an honest stop.

Detection works two ways, because one is not enough:

- **By label** — word stems, not whole words. `disabilit\w*` catches
  "disability" and "disabilities"; a trailing `\b` catches neither, which is
  how the first version silently missed them.
- **By options** — a radio group offering "Male / Female / Prefer not to say"
  is a demographic question whatever it is labelled. Ashby renders gender with
  no legend at all, so the group's label ends up being its first option.

## Reading a form

Radio and checkbox groups are read as **one** field, not one per option. Read
individually, a Lever ethnicity question arrives as nineteen fields labelled
"White: Irish", "Asian/Asian British: Indian" — none of which look demographic
on their own. That is exactly how a demographic question slips past a refusal
list, and fixing the grouping cut Lever's unknown fields from 66 to 8 while
raising its refusals from 2 to 8.

The DOM walk is written as one flat loop with no inner function declarations.
esbuild — which `tsx` uses in development — injects a `__name` helper for named
function expressions, and that helper does not exist inside the page:
`ReferenceError: __name is not defined` in dev, silence under `tsc`.

## Verified on live forms

Read-only, dry run, nothing submitted:

| Portal | Fields read | Auto-fillable | Refused | Unknown |
|---|---|---|---|---|
| Greenhouse (GitLab) | 19 | 7 | 6 | 6 |
| Lever (Spotify) | 23 | 7 | 8 | 8 |
| Ashby (Vanta) | 15 | 4 | 4 | 7 |

The unknowns are what the model rung and the cache exist to absorb, and they
shrink with use rather than staying constant.

## The live view

`WS /live/:attemptId` on the same HTTP server — one port to expose, one origin
for the browser to trust.

Two rules make it safe to run beside the API. Every socket is authenticated
before it is accepted (`noServer`, so an unauthenticated client never reaches
an open socket), and the attempt must belong to the user who opened it —
without that check any authenticated user could watch anyone's application.
The token rides as a query parameter because a browser WebSocket cannot set an
Authorization header.

With the hosted browser provider there are no frames at all: the session
publishes its own `liveUrl`, stored on the attempt, and the UI embeds it. That
is the real browser, so watching and taking over are the same act and there is
no coordinate mapping to get wrong.

Frame streaming remains for `BROWSER_PROVIDER=local`. Frames come from CDP's own
screencast rather than a screenshot loop: Chrome pushes one when the page
changes, so an idle form costs nothing. They are paced to about five a second
and **only produced while somebody is watching** — the gateway maintains a
Redis key while a socket is open, and the runner checks it before starting.

### Takeover

Not a video. When the runner blocks, it holds the same browser open for
`APPLY_TAKEOVER_WINDOW_MS` and forwards the user's clicks and keystrokes to it
over a Redis control channel. On release it re-reads the form and carries on
from wherever the user left it, rather than starting over.

The alert sound is armed on the first click in the panel, and the UI says
whether it is armed. Browsers refuse audio until a user gesture, and an alert
someone believes is armed but is not is worse than no alert.

### Verified

Cross-process, runner → Redis → gateway → browser:

| Case | Result |
|---|---|
| No token | rejected |
| Invalid token | rejected |
| Valid token, **another user's attempt** | rejected |
| Valid token, own attempt | accepted, `ready` received |
| `state` / `field` events published from a separate process | all four arrived in order |
