# Inbox and notifications

The whole feature answers one question: **did anyone reply about my
applications, and does it need me today.**

## The Gmail gate, first

`gmail.readonly` is a Google *restricted* scope. A public app using it must
pass a CASA security assessment by an approved lab, revalidated annually, at a
cost reporting puts anywhere from a few thousand dollars into the tens of
thousands. That is a real constraint and it is better known now than after the
integration is written.

Two paths, behind one `InboxSource` seam:

| | How | Cost |
|---|---|---|
| **Now** | OAuth client in testing mode, users added by hand | Free, up to 100 users, no assessment |
| **At scale** | A Huntly forwarding address and one Gmail filter the user sets once | No OAuth, no CASA, never expires |

The second is less magical and dramatically cheaper. `email_accounts.kind`
records which one an account uses; nothing downstream cares.

## Matching a reply to an application

The strongest signal is the sender's domain. Application mail almost never
comes from the company — it comes from whichever ATS they use, and that
envelope carries the same board token the application already recorded.

Three strategies, strongest first:

1. **A quoted job URL or requisition id.** Unambiguous when present.
2. **ATS domain, narrowed by company.** The domain says which *system*, the
   company says which *employer*. One without the other is not enough: every
   Greenhouse customer mails from `greenhouse-mail.io`.
3. **The company name**, from the sender's own domain or the subject.

**It refuses to guess.** Two applications on the same ATS with nothing to
separate them returns no match at all. Telling someone Stripe replied when it
was Shopify is not a cosmetic error — it is a mistake they will act on, and an
unmatched notification they can still read is strictly better.

Company matching normalises away suffixes (`Pvt Ltd`, `Technologies`) and
ignores names under three characters, which would otherwise match almost any
subject line.

## Classification

`interview_invite` · `assessment` · `rejection` · `recruiter_outreach` ·
`application_ack` · `other`

A keyword prefilter decides what is even about a job; the model decides what it
is and extracts company, role, next step, and a date **only when the mail
states one** — "soon" and "next week" are not dates.

Two rules the prompt is explicit about, because both are easy to get wrong: an
automated acknowledgement is not an interview invite however warm it reads, and
a rejection should be called a rejection rather than softened into "other",
where it sits in someone's queue forever.

Without a model configured this degrades to keywords at a confidence that says
plainly it is a keyword match.

## One feed, ordered by what needs you

| Kind | Urgency |
|---|---|
| Interview invite, assessment | `now` |
| Recruiter outreach, referral | `soon` |
| Rejection, acknowledgement | `fyi` |

`GET /notifications` orders by urgency and *then* by time — deliberately not
chronologically. A rejection that arrived an hour ago must not push this
morning's interview invite below the fold, and at a hundred applications a day
rejections are the most common thing in the mailbox.

Rejections being `fyi` is the same decision from the other side: greeting
someone with a wall of them every morning is how the one message that mattered
gets missed.

Verified with four seeded rows inserted in an order that would defeat a
chronological sort:

```
1. [now ] Stripe wants to schedule a call
2. [now ] Razorpay take-home, due Friday
3. [soon] Priya asked you for a referral
4. [fyi ] Shopify is not moving forward
```

## What is stored

Not the body. Only what was extracted from it — sender, subject, class,
company, role, next step, date. This table exists to answer one question, and
keeping the full text of someone's mail to answer it would be a much larger
promise than the feature needs to make.

## Not built

The Gmail client itself, and the Notifications tab in the UI. The client needs
OAuth credentials from a Google Cloud project that only the account owner can
create; the interface, the classifier, the matcher and the feed are all in
place and tested behind it.
