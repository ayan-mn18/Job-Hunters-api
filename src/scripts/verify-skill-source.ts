import { toDiscoveryAdapter } from '../hunt/discovery/runner.js'
import { skillById } from '../skills/registry.js'
import { hasFirecrawl } from '../config/env.js'

/**
 * Runs one site skill's source and says whether it actually returned jobs.
 *
 * This exists because of how the previous Work at a Startup adapter failed.
 * The site began answering plain HTTP clients with 406, the adapter caught the
 * error, returned an empty list, and every run since contributed zero postings
 * from it without anything reporting a problem. An empty result is a failure
 * here, printed as one.
 *
 * Costs Firecrawl credits: one per listing page, one per posting read.
 */

const id = process.argv[2] ?? 'workatastartup'
const limit = Number(process.argv[3] ?? 5)

const skill = skillById(id)
if (!skill?.source) {
  console.error(`No skill called "${id}" with a source. Try: workatastartup`)
  process.exit(1)
}
if (!hasFirecrawl) {
  console.error('FIRECRAWL_API_KEY is not set, so this source cannot read anything.')
  process.exit(1)
}

const adapter = toDiscoveryAdapter(skill.source)
const now = new Date()
const result = await adapter.fetchRecent({
  since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
  now,
  maxItems: limit,
  softwareOnly: false,
})

console.log(`${result.portal}: ${result.seen} seen, ${result.jobs.length} kept, ${result.durationMs}ms`)
console.log(`detail: ${result.detailFetched} read, ${result.detailFailed} failed`)
for (const warning of result.warnings) console.log(`  ! ${warning}`)
if (result.error) console.log(`  error: ${result.error}`)

for (const job of result.jobs.slice(0, limit)) {
  const description = job.descriptionText?.length ?? 0
  console.log(
    `\n  ${job.title} — ${job.company}` +
      `\n    ${job.url}` +
      `\n    location=${job.locations.map((location) => location.raw).join('/') || '—'}` +
      ` remote=${job.remote} type=${job.employmentType}` +
      `\n    salary=${job.salary.text ?? '—'} experience=${job.experience.text ?? '—'}` +
      ` description=${description} chars`,
  )
}

if (result.jobs.length === 0) {
  console.error('\nFAIL: the source returned nothing.')
  process.exit(1)
}
const withDescription = result.jobs.filter((job) => (job.descriptionText?.length ?? 0) > 400).length
console.log(
  `\n${withDescription}/${result.jobs.length} postings came back with a usable description.`,
)
if (withDescription === 0) {
  console.error('FAIL: the detail stage read nothing.')
  process.exit(1)
}
console.log('Source verified.')
