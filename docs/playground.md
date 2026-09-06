# The playground

One job, from a sentence to a confirmation email, with the browser visible the
whole way.

It exists because the rest of the product reports a status per row. "Applied",
"needs review", "failed" — none of which say *why*, and the two things most
likely to go wrong are exactly the two a status column hides: a login wall, and
a required question nobody can answer from a résumé.

## What happens

```
POST /playground/runs {prompt}
   → queued on huntly-playground, picked up by the runner
   → launching   hosted browser opens; liveUrl saved and published
   → searching   Muse reads the prompt, the site skill lists postings,
                 Muse ranks them against the user's Kit
   → shortlisted STOPS. Nothing is applied to until somebody presses Apply.
   → applying    the site skill (or the generic agent) fills the form
   → blocked     the agent called `ask`; the run waits for a person
   → submitted   an `applications` row is written and the receipt goes out
```

Every state change and every line of conversation is written to
`playground_runs` / `playground_messages` **and** published over Redis, in one
call — see `setState` and `say` in `src/playground/store.ts`. They were separate
in the first version and drifted the moment an error path forgot the second
half.

## Why it is not a flag on the hunt

The batch hunt and this share every underlying part: the same hosted browser,
the same site skills, the same agent loop, the same never-auto list. They differ
in one respect, and it is the whole feature — **this one stops and asks.**

A hunt parks a blocked application for review because there are ninety-nine
behind it. Here there is one, somebody is watching it, and the right response to
a form demanding a number nobody has is to ask them for it.

That is the `ask` tool in `src/agent/tools.ts`, offered only when a run supplies
an `onAsk` handler. A batch run does not, so the tool is not in its list at all
— an agent that could ask a question nobody will answer would just hang.

Asking is still bounded by the never-auto list. `ask` refuses a question that
matches it, so a model cannot route around a refusal by getting the user to
supply the answer instead.

## Waiting for a person

The run happens on the runner; the reply arrives at the API. Between them is a
Redis list with a blocking pop, not pub/sub — an answer typed a second before
the runner started listening would be published into an empty room and lost, and
losing the one answer somebody was asked for is the worst failure this has.

`awaitReply` takes the kinds it will accept. That is not politeness: without it,
a message typed while the run was still searching sits on the list and gets
popped later as the approval to send an application.

## The receipt

`src/playground/confirmation.ts`. Its contents are read off the outcome rather
than written as fixed copy — an earlier draft listed every field as sent
regardless, which on a run where something was left blank was untrue. This email
is the only artifact of a run that outlives it; an untrue one is worse than
none.

The policy sentence about visa and demographic questions only appears when a
policy-refused field is actually in the list. Attached to a field the user
merely chose to skip, it reads as Huntly refusing something it did not.

## Running one

```bash
npm run playground:smoke [email] [prompt]
```

Drives a whole run in-process, approves the shortlist the way the UI would,
prints the transcript. Forces a dry run: it fills a real form on a real
employer's site and stops before submitting.

Needs Redis, a hosted browser key, Firecrawl, Muse, and a user with a completed
Kit and a base résumé. Without SMTP the receipt is logged rather than sent, and
the run still reports success — the application was the thing that mattered and
it already happened.
