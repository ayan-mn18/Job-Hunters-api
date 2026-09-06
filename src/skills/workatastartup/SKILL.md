# Work at a Startup (Y Combinator)

`workatastartup.com` is YC's own job board. Every company on it is a funded YC
startup, listings are written by the founders rather than by a recruiting team,
and applying is closer to sending a message than to filling in an ATS form.

## Reading it

Browsing needs no account. Applying does — a YC account, created at
`account.ycombinator.com`, which the applicant creates themselves.

The site refuses plain HTTP clients: a direct request returns **406** whatever
user agent it carries. Read it through Firecrawl, which renders the page
properly. Listing pages are `/jobs` and `/jobs?page=N`, with role-filtered
variants like `/jobs/l/software-engineer`. A posting lives at `/jobs/{id}`.

Postings carry no publication date. Freshness is first-seen only — do not
present an age you cannot support.

## The application

Follow "Apply" from a posting while signed in. What appears is a short form
whose centre is a free-text message to the founders, not a field-by-field
questionnaire. Some companies add one or two of their own questions.

What actually matters here, and does not on a normal ATS:

- **The message is the application.** A generic paragraph is worse than none.
  Name the company's product, and say what the applicant has built that is
  close to it. Three to six sentences.
- **Founders read these.** Write as a person writing to a person. No
  "I am writing to express my interest in the aforementioned position".
- **Never claim experience the facts do not contain.** A YC founder will ask
  about it in the first reply, and an invented claim ends the conversation.
- One application per company. Applying to three roles at the same startup
  reads as a mass send, which is the opposite of the point.

Resume upload is usually optional because the YC profile already carries one.
Attach it when a file input is present.

## Do not

- Do not create an account. If the page asks for a sign-in, stop and report it:
  the applicant connects their own YC account.
- Do not touch the "Get matched with startups" or profile-editing flows. This
  skill applies to postings and nothing else.
- Do not follow a link off `workatastartup.com` or `ycombinator.com`.
