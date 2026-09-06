import type { SiteSkillManifest } from '../types.js'

export const linkedinManifest: SiteSkillManifest = {
  id: 'linkedin',
  label: 'LinkedIn',
  domains: ['linkedin.com'],
  allowedDomains: ['linkedin.com', 'www.linkedin.com'],
  authMode: 'profile',
  loginUrl: 'https://www.linkedin.com/login',
  loginCookieDomain: 'linkedin.com',
  /**
   * The one site that gets a residential exit.
   *
   * LinkedIn is the only surface here where the account, not the request, is
   * what gets lost — a datacentre address on a signed-in session is a fast way
   * to a checkpoint, and a checkpoint on someone's real LinkedIn is a much
   * worse outcome than a slow run. India, because that is where the users are.
   */
  proxyCountry: 'in',
  /** Deliberately slow. People-search at speed is what detection is tuned for. */
  minIntervalMs: 4_000,
  capabilities: { search: false, apply: false, outreach: true },
}

/** The portal id this skill's account is stored under, kept from before. */
export const LINKEDIN_PORTAL_ID = 'linkedin-referrals'
