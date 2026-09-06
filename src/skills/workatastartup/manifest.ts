import type { SiteSkillManifest } from '../types.js'

export const workAtAStartupManifest: SiteSkillManifest = {
  id: 'workatastartup',
  label: 'Work at a Startup (YC)',
  domains: ['workatastartup.com'],
  // YC's sign-in lives on `account.ycombinator.com` and the apply link goes
  // through it, so a run that cannot reach that domain cannot apply at all.
  allowedDomains: ['workatastartup.com', 'ycombinator.com', 'account.ycombinator.com'],
  authMode: 'profile',
  loginUrl: 'https://account.ycombinator.com/?continue=https%3A%2F%2Fwww.workatastartup.com%2F',
  loginCookieDomain: 'ycombinator.com',
  // Reads go through Firecrawl, which brings its own exit addresses; the
  // applying session is a normal signed-in browser and does not need one.
  proxyCountry: null,
  minIntervalMs: 1_000,
  capabilities: { search: true, apply: true, outreach: false },
}
