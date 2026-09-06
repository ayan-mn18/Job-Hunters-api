/**
 * Deciding which application a reply is about.
 *
 * The strongest signal is the sender's domain. Application mail almost never
 * comes from the company — it comes from whichever ATS they use, and that
 * envelope carries the board token the application already knows about.
 *
 * Getting this wrong is worse than not matching at all: telling someone
 * Stripe replied when it was Shopify is a mistake they will act on.
 */

export interface MatchableApplication {
  id: string
  company: string
  portalId: string | null
  jobUrl: string | null
  externalJobId: string | null
}

export interface MatchableEmail {
  fromAddress: string
  subject: string
  /** Any URLs quoted in the body. */
  links?: string[]
  company?: string | null
}

export type MatchStrategy = 'ats_domain' | 'url' | 'company' | null

export interface MatchResult {
  applicationId: string | null
  matchedBy: MatchStrategy
  confidence: number
}

/** ATS mail domains, mapped to the portal id an application records. */
const ATS_DOMAINS: Array<[RegExp, string]> = [
  [/(?:^|\.)greenhouse\.io$/i, 'greenhouse'],
  [/(?:^|\.)us\.greenhouse-mail\.io$/i, 'greenhouse'],
  [/(?:^|\.)greenhouse-mail\.io$/i, 'greenhouse'],
  [/(?:^|\.)lever\.co$/i, 'lever'],
  [/(?:^|\.)hire\.lever\.co$/i, 'lever'],
  [/(?:^|\.)ashbyhq\.com$/i, 'ashby'],
  [/(?:^|\.)smartrecruiters\.com$/i, 'smartrecruiters'],
  [/(?:^|\.)workable\.com$/i, 'workable'],
  [/(?:^|\.)myworkday(?:jobs)?\.com$/i, 'workday'],
  [/(?:^|\.)icims\.com$/i, 'icims'],
  [/(?:^|\.)wellfound\.com$/i, 'wellfound'],
  [/(?:^|\.)instahyre\.com$/i, 'instahyre'],
  [/(?:^|\.)naukri\.com$/i, 'naukri'],
]

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  if (at === -1) return address.trim().toLowerCase()
  return address.slice(at + 1).trim().toLowerCase().replace(/>$/, '')
}

export function atsFor(address: string): string | null {
  const domain = domainOf(address)
  for (const [pattern, portal] of ATS_DOMAINS) {
    if (pattern.test(domain)) return portal
  }
  return null
}

function normaliseCompany(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|limited|corp|corporation|gmbh|pvt|private|technologies|technology)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Does the company name appear in this text as a whole word?
 *
 * Substring matching is not good enough: "Stripe" inside "Stripey Ltd" is a
 * different employer, and a two-letter company name would match almost
 * anything.
 */
function mentionsCompany(text: string, company: string): boolean {
  const needle = normaliseCompany(company)
  if (needle.length < 3) return false
  return normaliseCompany(text).includes(needle)
}

export function matchEmail(
  email: MatchableEmail,
  applications: MatchableApplication[],
): MatchResult {
  if (applications.length === 0) return { applicationId: null, matchedBy: null, confidence: 0 }

  const haystack = [email.subject, ...(email.links ?? [])].join(' ')

  // 1. A URL quoting the exact job. Unambiguous when it happens.
  for (const application of applications) {
    if (!application.jobUrl) continue
    for (const link of email.links ?? []) {
      if (link.includes(application.jobUrl) || application.jobUrl.includes(link)) {
        return { applicationId: application.id, matchedBy: 'url', confidence: 0.98 }
      }
    }
    if (application.externalJobId && haystack.includes(application.externalJobId)) {
      return { applicationId: application.id, matchedBy: 'url', confidence: 0.95 }
    }
  }

  // 2. The ATS domain, narrowed by company. The domain says which system, the
  // company says which employer — one without the other is not enough, because
  // every Greenhouse customer mails from the same domain.
  const ats = atsFor(email.fromAddress)
  if (ats) {
    const sameAts = applications.filter((application) => application.portalId === ats)
    const named = sameAts.filter((application) => mentionsCompany(haystack, application.company))

    if (named.length === 1 && named[0]) {
      return { applicationId: named[0].id, matchedBy: 'ats_domain', confidence: 0.9 }
    }
    // One application on this ATS and nothing contradicting it.
    if (named.length === 0 && sameAts.length === 1 && sameAts[0]) {
      return { applicationId: sameAts[0].id, matchedBy: 'ats_domain', confidence: 0.7 }
    }
    // Several candidates and no way to choose is not a match. Guessing here is
    // exactly the mistake that tells someone the wrong company replied.
    if (named.length > 1) return { applicationId: null, matchedBy: null, confidence: 0 }
  }

  // 3. The company name, from the sender's own domain or the subject.
  const senderDomain = domainOf(email.fromAddress)
  const byCompany = applications.filter(
    (application) =>
      mentionsCompany(senderDomain, application.company) ||
      mentionsCompany(email.subject, application.company),
  )
  if (byCompany.length === 1 && byCompany[0]) {
    return { applicationId: byCompany[0].id, matchedBy: 'company', confidence: 0.75 }
  }

  return { applicationId: null, matchedBy: null, confidence: 0 }
}
