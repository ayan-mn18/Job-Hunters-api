/**
 * Company job boards, by ATS.
 *
 * Every token here was probed against its board API and returned postings —
 * dead tokens are not carried, because each one costs a request and a warning
 * on every run. Re-probe with `npm run boards:probe` before adding more.
 *
 * The point of the size is volume: matching at a 75% bar means most postings
 * are rejected, so the funnel has to start wide enough that what survives is
 * still a useful list.
 */

export const GREENHOUSE_BOARDS = [
  'stripe', 'gitlab', 'databricks', 'cloudflare', 'discord', 'robinhood', 'careem',
  'tamara', 'instacart', 'airtable', 'asana', 'brex', 'chime', 'coinbase', 'dropbox',
  'figma', 'flexport', 'gusto', 'lyft', 'mongodb', 'netlify', 'nuro', 'pinterest',
  'reddit', 'samsara', 'sofi', 'twilio', 'vercel', 'webflow', 'affirm', 'betterment',
  'carta', 'checkr', 'coursera', 'datadog', 'duolingo', 'elastic', 'faire', 'fastly',
  'klaviyo', 'lattice', 'mercury', 'monzo', 'postman', 'roblox', 'scaleai', 'starburst',
  'tanium', 'tripadvisor', 'truelayer', 'upgrade', 'verkada', 'anthropic', 'airbnb',
  // India-based, added because the US-heavy list above put almost everything
  // outside the locations this hunt actually targets.
  'phonepe', 'groww', 'inmobi', 'turing', 'slice', 'truecaller',
] as const

export const LEVER_BOARDS = [
  'palantir', 'matchgroup', 'spotify', 'latch', 'veeva', 'swile', 'qonto',
  'contentsquare', 'ledger', 'blablacar', 'jobandtalent',
  'meesho', 'cred', 'mindtickle', 'paytm',
] as const

export const ASHBY_BOARDS = [
  'ramp', 'linear', 'vanta', 'posthog', 'cursor', 'openai', 'replit', 'modal',
  'browserbase', 'resend', 'neon', 'railway', 'render', 'supabase', 'warp', 'abridge',
  'sardine', 'mercor', 'perplexity', 'harvey', 'ironcladhq', 'watershed', 'found',
  'atlan', 'sarvam',
] as const

export const SMARTRECRUITERS_BOARDS = ['Visa', 'Sodexo', 'Continental'] as const

export const WORKABLE_BOARDS = ['huntress', 'tide'] as const

/**
 * The board token is not the company's name. Greenhouse and Ashby return the
 * real name on the posting itself; this only has to be a readable fallback for
 * the few that do not.
 */
export function companyNameFor(token: string): string {
  const special: Record<string, string> = {
    gitlab: 'GitLab',
    scaleai: 'Scale AI',
    sofi: 'SoFi',
    truelayer: 'TrueLayer',
    matchgroup: 'Match Group',
    ironcladhq: 'Ironclad',
    blablacar: 'BlaBlaCar',
    jobandtalent: 'Jobandtalent',
    mongodb: 'MongoDB',
    openai: 'OpenAI',
    posthog: 'PostHog',
    tripadvisor: 'Tripadvisor',
    contentsquare: 'Contentsquare',
    phonepe: 'PhonePe',
    inmobi: 'InMobi',
    cred: 'CRED',
    mindtickle: 'Mindtickle',
    truecaller: 'Truecaller',
  }
  return special[token] ?? token.charAt(0).toUpperCase() + token.slice(1)
}
