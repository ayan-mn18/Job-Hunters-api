# Outbound referrals

Name a company. Huntly finds people there who could refer you, ranks them,
writes the ask, and — only after you approve the words — sends it at human
pace from your own LinkedIn session.

## Read this part first

Automated connection requests violate LinkedIn's User Agreement. LinkedIn
enforces its own weekly invitation ceiling and restricts **member accounts**
when behaviour looks automated. The account at risk is the user's, not the
server's.

That is why the rails were the first file written in this module, not the
last, and why `limits.ts` is imported by every path that could send something
rather than being re-checked at each call site.

## The rails

| Rail | Default | Why this number |
|---|---|---|
| Invites per day | 15 | LinkedIn's weekly ceiling starts around 100. Fifteen a day sits well under it with room for a bad week. |
| Invites per week | 60 | A hard stop regardless of unused daily budget. |
| Per company per day | 5 | Five people at one company hearing from you the same afternoon is the pattern *humans* notice, never mind the algorithm. |
| Send window | 09:00–19:00 local | From `user_schedules.timezone`. Invitations at 03:00 are the clearest automation tell there is. |
| Gap between sends | 4–12 min, jittered | Randomised. Never a fixed interval. |
| Withdraw unaccepted | 21 days | A low acceptance rate is itself a flag; withdrawing protects the ratio. |
| Approval | required | Nothing sends without `outreach_messages.approved_at`. |
| Circuit breaker | 72 h | Any checkpoint or challenge pauses **all** automation on the account. |

Never automated, whatever the caps say: endorsements, profile views at scale,
group joins, comments, posts, and messages to people who have not accepted.

Two structural choices back these up:

**Caps count rows, not counters.** `sentCounts` counts `outreach_prospects`
with an `invited_at`, rather than trusting the counters on `account_health`. A
counter that drifts — a crashed worker, a manual edit — drifts in the direction
of sending *more*, and that is the one direction that costs someone their
account.

**Concurrency 1, globally.** Not per user. The pacing between sends is measured
in minutes; a queue that could run two of these side by side would defeat every
cap the moment a second user existed.

## Finding people

Four sources, in preference order. The first two are both safer and
higher-converting than the third:

1. **First-degree connections at the company.** No search, no invitation, no
   risk taken — just a message to someone who already accepted you. Highest
   conversion in the engine, and most people have more of these than they
   remember. These skip straight to `accepted`.
2. **Ex-colleagues and alumni now there.** A shared employer or school is the
   strongest cold open available.
3. **Second degree via a strong mutual.** The mutual's name goes in the note.
4. **Cold people-search.** Last resort, tightest caps, the only rung that needs
   LinkedIn search.

## Ranking

```
0.35 relationship + 0.25 authority + 0.15 affinity + 0.15 recency + 0.10 reachability
```

Two weights carry an opinion:

**Authority caps at one level above.** Someone at your level or just above can
vouch for the work. Two levels up they are approving headcount, not reading
your code, and the referral is worth less even when it lands.

**Recency rewards recent joiners.** They have referral bonuses to claim and
fewer reasons to be protective of their own standing.

Top 5–8 per company, not fifty. However this engine fails, it will not be from
talking to too few people.

## Composing

A LinkedIn invitation note caps near 300 characters, which is a useful
constraint: it forces the specific over the generic. Every draft must name one
true, checkable thing — the shared employer, the school, the mutual, the team.

The system prompt forbids inventing one. If the context gives the model nothing
specific, it is told to say plainly why it is reaching out and keep it short,
because a short honest note beats a padded one. Without a model configured
there is a deterministic fallback that is deliberately plain rather than
clever.

The user's own name is on these messages. A generic "connect and refer me" sent
fifteen times a day is the LazyApply failure mode in a different medium.

## The state machine

```
identified → drafted → approved → invited → accepted → asked → referred
                                                     ↘ declined  ↘ withdrawn
```

First-degree prospects skip to `accepted` — there is no invitation to send.
`nextSendable` refuses to send an `ask` to anyone not in `accepted`, so an
approved follow-up can never reach a stranger.

## The breaker

`sendInvite` and `sendMessage` check for a checkpoint before acting and again
after. On detection they throw `CheckpointError`, the worker calls
`tripBreaker`, and everything on that account stops for 72 hours with an
activity entry explaining why.

If the platform is asking whether the user is a human, the correct response is
to stop being suspicious — not to try again more carefully.

## What the user sees

The **account-health strip leads the screen**, above the feature itself:
invites today and this week against their caps, acceptance rate, checkpoints in
the last 30 days, and whether the breaker is open. If this engine is ever
quietly damaging someone's account, that strip is where it shows first, so it
is not a settings sub-page.

Below it: companies, ranked people with their signals visible, and every draft
in a tray waiting for approval. Editing a draft un-approves it — the words that
were approved are the words that send.

## Finding, in practice

`find.ts` runs two passes during the daily LinkedIn sweep, in the same locked
job as the referral sync — sequential, never concurrent, so the account never
has two sessions live at once.

The first pass filters LinkedIn's own people search to first-degree
connections. It is the safest possible read and the highest-converting result:
those prospects skip the invitation entirely. The second, wider pass runs
**only if the first found fewer than five people** — if someone already knows
eight people at the company there is no reason to touch cold search at all.

Two caps: 25 results per pass, 2 pages, 2 companies per sweep. Every page load
is followed by a two-to-five second dwell, because a page opened and read
inside 300 ms is a machine.

What a search card does *not* publish is as important as what it does. There is
no education history and no city on a result, so `sharedSchool` and
`sharedCity` stay false rather than being guessed. An invented "we went to the
same university" in a draft would be worse than a duller note — and the user's
name is on it.
