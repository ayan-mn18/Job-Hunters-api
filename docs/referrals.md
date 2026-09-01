# Inbound referrals

People message you asking to be referred. This gathers them into one pile and
drafts your reply.

## The DMs tab is gone

`pages/LinkedInDms.tsx`, the nav entry and the `/app/dms` route are removed.
The `linkedin_conversations` and `linkedin_messages` tables stay, and so does
`GET /referrals/linkedin/messages` — they are the referral pipeline's source of
record. The surface went; the data did not.

## Two stages, because one cannot do both jobs

A regex is free and catches almost every real request, but it also catches "I
got a referral last year" and misses anyone who phrased it politely. A model
reads the thread and knows the difference, but is too expensive to run over an
entire inbox.

So **the regex decides what to look at, and the model decides what it is.**

The prefilter is deliberately loose. It was widened from the original four
patterns — which required the word "refer" next to a request, and so silently
dropped *"I applied to the Senior Backend position at your company last week"*
and *"I saw an opening on your team and wondered if you could help"*. A false
positive costs one classification; a false negative costs someone their
referral.

## Threads, not messages

The classifier reads the whole conversation. A referral ask routinely spans
three messages — a greeting, some context, then the request — and none of them
contains the word "refer" on its own. Judging the first message alone was the
single biggest source of misses.

It extracts what the thread actually states: target role, company, requisition
id, how well they seem to know you, urgency. Never inferred — if the company is
not written down, it stays null.

## The "maybe" pile

| Verdict | Confidence | Goes to |
|---|---|---|
| `request` | ≥ 0.75 | the referral pile |
| `request` or `unclear` | 0.4 – 0.75 | **maybe** |
| anything | < 0.4 | ignored |
| `not_request` | any | ignored |

The middle bucket exists because the alternative is silently discarding
anything the model was unsure about. Dropping a real referral request costs
much more than showing one extra card someone dismisses in a second.

Without a model configured the prefilter's opinion stands, at a confidence that
says plainly it is a keyword match rather than a judgement.

## Drafts

`referral-draft.ts` has had a `setReferralDraftGenerator()` seam and a template
stub behind it since the beginning. The real generator is now registered at
boot whenever a model is configured.

One rule governs it: **no claim that is not in the source documents.** This
text goes out under your name to a colleague at your own company. A flattering
invention — a metric nobody hit, a project nobody worked on — is a reputational
hazard for *you*, and you may not catch it before sending.

So the prompt makes omission the safe default: with thin source material the
draft is short and hedged rather than padded. With nothing but their message it
is told explicitly to write two sentences and not characterise their
experience.

Without a model the template stub stays. A serviceable skeleton you can edit
beats an error where a draft should be.

## Not built

The "maybe" bucket is counted and returned by the sync (`maybeThreads`), but
the Referrals screen does not render it as a separate pile yet. Recall on a
hand-labelled set of real threads is unmeasured — it needs a connected account
and a person to say which of their own threads were genuine requests.
