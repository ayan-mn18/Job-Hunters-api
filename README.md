# Job Hunters — API

Backend for [Job-Hunters-UI](https://github.com/ayan-mn18/Job-Hunters-UI).

**Status: not implemented yet.** The UI runs entirely on mock data. This README
records the shape the API is expected to take so the two repos stay in step.

## Two products

### 1. The Hunt — automated applying

A daily pipeline:

1. Parse the user's base resume into a structured profile (skills, titles, years).
2. Scrape connected job portals for new postings.
3. Score each posting against the user's spec (roles, companies, locations,
   minimum match score, deal breakers).
4. Tailor a resume variant per job description.
5. Fill and submit the application, using the stored "My Kit" answers
   (address, phone, notice period, CTC, work authorization, and so on).

Target throughput is 50–100 applications a day.

Portals in scope: LinkedIn, Wellfound, RemoteOK, We Work Remotely,
YC Work at a Startup, Naukri, Instahyre, Indeed — more to be added.

### 2. Referrals — inbound requests, gathered

Daily sweep of the user's Gmail and LinkedIn DMs for people asking for a
referral. For each request, collect: sender, their resume (file or link),
target role, job ID, and the original message. Then generate a recommendation
message from their resume plus the job description, ready to copy and send.

Grouped by day, so opening "7 August" shows that day's requests
(e.g. 7 DMs + 4 emails = 11) in one place.

## Planned endpoints

```
GET    /me                        profile + "My Kit" answers
PUT    /me/kit                    update kit
POST   /me/resume                 upload base resume, returns parsed profile

GET    /portals                   connected portals + counts
PUT    /portals/:id               connect / disconnect

GET    /hunt/spec                 roles, companies, locations, thresholds
PUT    /hunt/spec
POST   /hunt/start                kick off a run
POST   /hunt/stop
GET    /hunt/status               live run progress

GET    /applications              list, filter by status
GET    /applications/:id

GET    /referrals/days            per-day counts (linkedin + email)
GET    /referrals?date=YYYY-MM-DD requests for a day
POST   /referrals/:id/draft       regenerate the recommendation
PATCH  /referrals/:id             mark handled
```

## Not decided yet

- Runtime and framework
- Database
- How portal sessions are stored (this is the sensitive part — credentials must
  never be logged, and portal ToS need a read before scraping is turned on)
- Scheduler for the daily run
