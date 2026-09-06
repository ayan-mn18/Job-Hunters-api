import { extractExperience } from './extract/experience.js'
import { extractResponsibilities } from './extract/responsibilities.js'
import { extractSalary, formatSalary } from './extract/salary.js'
import { extractSkills, skillNames } from './extract/skills.js'
import { splitSections } from './extract/sections.js'
import { htmlToInlineText, htmlToText, sanitiseHtml } from './html.js'
import { fingerprintOf, inferRemoteMode, normaliseLocations } from './normalise.js'
import type {
  ExtractionMeta,
  JobDetail,
  JobStub,
  RawSalary,
  ScrapedJob,
} from './types.js'

/**
 * Turns a list-stage stub plus whatever the detail stage managed to fetch into
 * the single enriched record the rest of the pipeline stores.
 *
 * All extraction happens here rather than inside each adapter, so a new source
 * only has to produce a stub and a way to fetch its detail page — it gets
 * skills, experience, responsibilities and salary parsing for free, and the
 * quality of those fields does not drift per portal.
 */

const EMPTY_SALARY: RawSalary = { min: null, max: null, currency: null, period: null, text: null }

/**
 * Board-specific trailers that are not part of the posting: RemoteOK appends a
 * scrape canary asking applicants to quote a word, and several feeds tack a
 * marketing line onto every description.
 */
const BOILERPLATE = [
  /please\s+mention\s+the\s+word[\s\S]{0,200}?when\s+applying[^\n]*/gi,
  /apply\s+now\s+and\s+work\s+remotely\s+at\s+[^\n]*/gi,
  /#li-[a-z0-9-]+/gi,
]

function scrub(text: string): string {
  let result = text
  for (const pattern of BOILERPLATE) result = result.replace(pattern, ' ')
  return result.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function pickDescription(stub: JobStub, detail: JobDetail | null): {
  html: string | undefined
  text: string
  fromDetail: boolean
} {
  const detailHtml = detail?.descriptionHtml?.trim()
  const detailText = detail?.descriptionText?.trim()
  // The detail page wins whenever it produced something substantial — list
  // endpoints usually carry a truncated blurb, and a longer body is the whole
  // point of the second request.
  if (detailHtml && htmlToInlineText(detailHtml).length > 200) {
    return { html: sanitiseHtml(detailHtml), text: scrub(htmlToText(detailHtml)), fromDetail: true }
  }
  if (detailText && detailText.length > 200) {
    return { html: undefined, text: scrub(detailText), fromDetail: true }
  }

  const stubHtml = stub.descriptionHtml?.trim()
  if (stubHtml) {
    return { html: sanitiseHtml(stubHtml), text: scrub(htmlToText(stubHtml)), fromDetail: false }
  }
  return { html: undefined, text: scrub(stub.descriptionText?.trim() ?? ''), fromDetail: false }
}

export function buildScrapedJob(
  stub: JobStub,
  detail: JobDetail | null,
  fetchedAt: string,
): ScrapedJob {
  const description = pickDescription(stub, detail)
  const sections = description.text ? splitSections(description.text) : []
  const meta: ExtractionMeta = {}

  const locationText = detail?.locationText?.trim() || stub.locationText || ''
  const locations = normaliseLocations(locationText)
  meta.locations = detail?.locationText
    ? { method: 'jsonld', confidence: 0.9 }
    : { method: 'source', confidence: locationText ? 0.85 : 0.2, sourceField: 'list' }

  const remote =
    detail?.remote ??
    stub.remote ??
    inferRemoteMode(`${locationText} ${stub.title} ${description.text.slice(0, 2000)}`, locations)

  const employmentType = detail?.employmentType ?? stub.employmentType ?? 'unknown'
  if (employmentType !== 'unknown') {
    meta.employmentType = {
      method: detail?.employmentType ? 'jsonld' : 'source',
      confidence: 0.9,
    }
  }

  const skills = extractSkills({
    title: stub.title,
    descriptionText: description.text,
    tags: stub.tags,
    ...(detail?.skills ? { declaredSkills: detail.skills } : {}),
    sections,
  })
  meta.skills = {
    method: detail?.skills?.length ? 'jsonld' : 'parsed',
    confidence: skills.length === 0 ? 0 : Math.min(1, 0.5 + skills.length * 0.06),
  }

  const experience = extractExperience({
    title: stub.title,
    descriptionText: description.text,
    sections,
    ...(detail?.experience?.min !== null && detail?.experience?.min !== undefined
      ? { monthsFromSource: detail.experience.min * 12 }
      : {}),
    ...(detail?.experience?.text ? { experienceTextFromSource: detail.experience.text } : {}),
  })
  meta.experience = {
    method: detail?.experience?.min != null ? 'jsonld' : 'parsed',
    confidence: experience.min === null ? 0 : experience.text ? 0.8 : 0.5,
  }

  const responsibilities = extractResponsibilities({
    descriptionText: description.text,
    sections,
  })
  meta.responsibilities = {
    method: 'parsed',
    confidence: responsibilities.length === 0 ? 0 : responsibilities.length >= 3 ? 0.8 : 0.5,
  }

  const salary = extractSalary({
    descriptionText: description.text,
    fromSource: detail?.salary ?? stub.salary,
    ...(stub.salary?.text ? { sourceText: stub.salary.text } : {}),
  })
  const salaryResolved: RawSalary =
    salary.min === null && salary.max === null
      ? EMPTY_SALARY
      : { ...salary, text: salary.text ?? formatSalary(salary) }
  meta.salary = {
    method: detail?.salary || stub.salary ? 'source' : 'parsed',
    confidence: salaryResolved.min === null ? 0 : detail?.salary || stub.salary ? 0.95 : 0.6,
  }

  meta.description = {
    method: description.fromDetail ? 'source' : 'derived',
    confidence: description.text.length > 500 ? 0.9 : description.text.length > 0 ? 0.4 : 0,
    sourceField: description.fromDetail ? 'detail' : 'list',
  }

  const postedAt = detail?.postedAt ?? stub.postedAt

  return {
    sourceId: stub.sourceId,
    portal: stub.portal,
    url: stub.url,
    ...(detail?.applyUrl || stub.applyUrl ? { applyUrl: detail?.applyUrl ?? stub.applyUrl } : {}),
    title: stub.title.trim(),
    company: stub.company.trim(),
    locations,
    remote,
    employmentType,
    ...(description.text ? { descriptionText: description.text } : {}),
    ...(description.html ? { descriptionHtml: description.html } : {}),
    responsibilities,
    skills: skillNames(skills),
    experience,
    salary: salaryResolved,
    tags: stub.tags,
    postedAt,
    postedAtPrecision: stub.postedAtPrecision,
    fetchedAt,
    fingerprint: fingerprintOf(stub.title, stub.company, locations),
    extractionMeta: meta,
    detailFetched: description.fromDetail,
    raw: stub.raw,
  }
}
