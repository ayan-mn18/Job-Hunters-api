export type PostedAtPrecision = 'exact' | 'day' | 'first-seen'
export type RemoteMode = 'remote' | 'hybrid' | 'onsite' | 'unknown'

export interface NormalisedLocation {
  raw: string
  city?: string
  country?: string
  countryCode?: string
  isRemote: boolean
}

export interface ScrapedJob {
  sourceId: string
  portal: string
  url: string
  applyUrl?: string
  title: string
  company: string
  locations: NormalisedLocation[]
  remote: RemoteMode
  descriptionText?: string
  tags: string[]
  postedAt: string
  postedAtPrecision: PostedAtPrecision
  fetchedAt: string
  fingerprint: string
  raw?: unknown
}

export interface DiscoveryContext {
  since: Date
  now: Date
  maxItems: number
}

export interface AdapterResult {
  portal: string
  seen: number
  jobs: ScrapedJob[]
  warnings: string[]
  error?: string
  durationMs: number
}

export interface DiscoveryAdapter {
  id: string
  label: string
  fetchRecent(context: DiscoveryContext): Promise<AdapterResult>
}
