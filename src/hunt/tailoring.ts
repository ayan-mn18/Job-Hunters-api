import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { chromium } from 'playwright-core'
import { extractText } from 'unpdf'
import { env } from '../config/env.js'
import { db } from '../db/client.js'
import { huntCandidates, huntRunJobs, jobs, resumeVariants, resumes } from '../db/schema.js'
import { badRequest, notFound } from '../lib/errors.js'
import { buildObjectKey, downloadObject, uploadObject } from '../lib/storage.js'
import { keywordTokens } from './discovery/normalise.js'
import { resumeDocumentSchema, type ResumeDocument } from './resume-document.js'

interface TailoringPlan {
  skillOrder: string[]
  experience: Array<{ experienceId: string; bulletIds: string[] }>
  changedFields: string[]
  rule: 'reorder-only'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function overlapScore(text: string, keywords: string[]): number {
  const tokens = new Set(keywordTokens(text))
  return keywords.reduce((score, keyword) => score + (tokens.has(keyword) ? 1 : 0), 0)
}

function planFor(document: ResumeDocument, description: string): TailoringPlan {
  const keywords = keywordTokens(description)
  const skillOrder = [...document.skills]
    .sort((left, right) => overlapScore(right.name, keywords) - overlapScore(left.name, keywords))
    .map((skill) => skill.id)
  const experience = document.experience.map((item) => ({
    experienceId: item.id,
    bulletIds: [...item.bullets]
      .sort((left, right) => overlapScore(right.text, keywords) - overlapScore(left.text, keywords))
      .map((bullet) => bullet.id),
  }))
  const originalSkills = document.skills.map((skill) => skill.id)
  const changedFields = originalSkills.some((id, index) => skillOrder[index] !== id)
    ? ['skillsOrder']
    : []
  if (experience.some((item, index) => {
    const original = document.experience[index]?.bullets.map((bullet) => bullet.id) ?? []
    return item.bulletIds.some((id, bulletIndex) => original[bulletIndex] !== id)
  })) changedFields.push('bulletOrder')
  return { skillOrder, experience, changedFields, rule: 'reorder-only' }
}

function renderHtml(document: ResumeDocument, plan: TailoringPlan): string {
  const skillById = new Map(document.skills.map((skill) => [skill.id, skill]))
  const experienceById = new Map(document.experience.map((item) => [item.id, item]))
  const links = document.basics.links
    .map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a>`)
    .join(' · ')
  const experiences = plan.experience.map((entry) => {
    const item = experienceById.get(entry.experienceId)
    if (!item) return ''
    const bulletById = new Map(item.bullets.map((bullet) => [bullet.id, bullet]))
    const bullets = entry.bulletIds
      .map((id) => bulletById.get(id))
      .filter((bullet) => bullet !== undefined)
      .map((bullet) => `<li>${escapeHtml(bullet.text)}</li>`)
      .join('')
    const dates = [item.startedOn, item.isCurrent ? 'Present' : item.endedOn].filter(Boolean).join(' – ')
    return `<article><h3>${escapeHtml(item.role)} — ${escapeHtml(item.company)}</h3><p>${escapeHtml(dates)}</p><ul>${bullets}</ul></article>`
  }).join('')
  const skills = plan.skillOrder
    .map((id) => skillById.get(id)?.name)
    .filter((name) => name !== undefined)
    .map(escapeHtml)
    .join(', ')

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;font-size:10.5pt;line-height:1.35;margin:0}h1{font-size:21pt;margin:0}h2{font-size:12pt;text-transform:uppercase;border-bottom:1px solid #222;margin:14px 0 6px}h3{font-size:11pt;margin:8px 0 0}p{margin:2px 0}ul{margin:4px 0 6px;padding-left:18px}li{margin:2px 0}a{color:#111;text-decoration:none}.contact{margin-top:3px}.summary{margin-top:6px}article{break-inside:avoid}
  </style></head><body>
    <h1>${escapeHtml(document.basics.fullName)}</h1>
    <p>${escapeHtml(document.basics.headline)}</p>
    <p class="contact">${escapeHtml([document.basics.email, document.basics.phone, document.basics.city].filter(Boolean).join(' · '))}${links ? ` · ${links}` : ''}</p>
    ${document.summary ? `<h2>Summary</h2><p class="summary">${escapeHtml(document.summary)}</p>` : ''}
    <h2>Skills</h2><p>${skills}</p>
    <h2>Experience</h2>${experiences}
  </body></html>`
}

async function renderPdf(document: ResumeDocument, plan: TailoringPlan): Promise<Buffer> {
  const executablePath = env.CHROMIUM_EXECUTABLE_PATH
    ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined)
  if (!executablePath) throw badRequest('CHROMIUM_EXECUTABLE_PATH is required to tailor resumes.')
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(renderHtml(document, plan), { waitUntil: 'load' })
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
  } finally {
    await browser.close()
  }
}

export async function createMinimalResumeVariant(userId: string, candidateId: string) {
  const [row] = await db
    .select({ candidate: huntCandidates, job: jobs })
    .from(huntCandidates)
    .innerJoin(jobs, eq(huntCandidates.jobId, jobs.id))
    .where(and(eq(huntCandidates.id, candidateId), eq(huntCandidates.userId, userId)))
    .limit(1)
  if (!row) throw notFound('Hunt candidate not found')

  const [base] = await db
    .select()
    .from(resumes)
    .where(and(eq(resumes.userId, userId), eq(resumes.isBase, true)))
    .limit(1)
  if (!base) throw badRequest('Upload a base resume before tailoring.')

  const document = resumeDocumentSchema.safeParse(base.structuredDocument)
  const roleSlug = row.job.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  const fileName = `${document.success ? document.data.basics.fullName : 'resume'}-${roleSlug || 'job'}.pdf`
  let storagePath = base.storagePath
  let contentHash: string
  let plan: TailoringPlan | { changedFields: []; rule: 'unchanged-base'; reason: string }
  let changed = false

  if (document.success && base.structuredConfirmedAt) {
    plan = planFor(document.data, `${row.job.title} ${row.job.descriptionText ?? ''}`)
    const pdf = await renderPdf(document.data, plan)
    const extracted = await extractText(new Uint8Array(pdf), { mergePages: true })
    const required = [document.data.basics.fullName, 'Skills', 'Experience'].filter(Boolean)
    if (required.some((value) => !extracted.text.toLowerCase().includes(value.toLowerCase()))) {
      throw new Error('Tailored resume failed its parseability gate.')
    }
    storagePath = buildObjectKey(userId, 'variant', fileName)
    await uploadObject({ key: storagePath, body: pdf, mimeType: 'application/pdf' })
    contentHash = crypto.createHash('sha256').update(pdf).digest('hex')
    changed = plan.changedFields.length > 0
  } else {
    plan = {
      changedFields: [],
      rule: 'unchanged-base',
      reason: 'Structured resume is not confirmed; original resume preserved exactly.',
    }
    const original = await downloadObject(base.storagePath)
    contentHash = crypto.createHash('sha256').update(original).digest('hex')
  }

  const [variant] = await db
    .insert(resumeVariants)
    .values({
      userId,
      candidateId,
      baseResumeId: base.id,
      fileName: changed ? fileName : base.fileName,
      storagePath,
      plan,
      changed,
      contentHash,
    })
    .onConflictDoUpdate({
      target: resumeVariants.candidateId,
      set: { fileName: changed ? fileName : base.fileName, storagePath, plan, changed, contentHash, updatedAt: new Date() },
    })
    .returning()
  if (!variant) throw new Error('Could not create resume variant')

  await db
    .update(huntCandidates)
    .set({ resumeVariantId: variant.id, status: 'tailored', updatedAt: new Date() })
    .where(eq(huntCandidates.id, candidateId))
  await db
    .update(huntRunJobs)
    .set({ status: 'tailored', updatedAt: new Date() })
    .where(and(
      eq(huntRunJobs.runId, row.candidate.runId),
      eq(huntRunJobs.jobId, row.candidate.jobId),
    ))
  return variant
}
