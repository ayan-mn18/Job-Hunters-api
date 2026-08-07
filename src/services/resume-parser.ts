import mammoth from 'mammoth'
import { extractText } from 'unpdf'
import { z } from 'zod'
import { logger } from '../lib/logger.js'

export interface ParsedEmployment {
  role: string
  company: string
  startedOn?: string | null
  endedOn?: string | null
  isCurrent?: boolean
  blurb?: string | null
}

export interface ParsedResume {
  /** Skill names, deduplicated, in confidence order. */
  skills: string[]
  /** Job titles held, most recent first. */
  titles: string[]
  /** Rounded total years of professional experience. */
  yearsExperience: number | null
  employments: ParsedEmployment[]
  /** Contact details the parser could pull out, to prefill My Kit. */
  contact: {
    fullName?: string | null
    email?: string | null
    phone?: string | null
    city?: string | null
    linkedinUrl?: string | null
    githubUrl?: string | null
    portfolioUrl?: string | null
  }
  /** Plain text, kept for the tailoring step. */
  rawText?: string | null
}

export interface ParseRequest {
  resumeId: string
  userId: string
  fileName: string
  mimeType: string
  storagePath: string
  /** Present when the caller still has the bytes in hand. */
  buffer?: Buffer
}

export interface ResumeParser {
  readonly name: string
  /** True when the implementation actually reads the document. */
  readonly isReal: boolean
  parse(request: ParseRequest): Promise<ParsedResume>
}

const parsedEmploymentSchema = z.object({
  role: z.string().trim().min(1),
  company: z.string().trim().min(1),
  startedOn: z.string().nullable().optional(),
  endedOn: z.string().nullable().optional(),
  isCurrent: z.boolean().optional(),
  blurb: z.string().nullable().optional(),
})

const parsedResumeSchema = z.object({
  skills: z.array(z.string()),
  titles: z.array(z.string()),
  yearsExperience: z.number().int().nonnegative().nullable(),
  employments: z.array(parsedEmploymentSchema),
  contact: z.object({
    fullName: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    linkedinUrl: z.string().nullable().optional(),
    githubUrl: z.string().nullable().optional(),
    portfolioUrl: z.string().nullable().optional(),
  }),
  rawText: z.string().nullable().optional(),
})

export function readParsedResume(value: unknown): ParsedResume | null {
  const result = parsedResumeSchema.safeParse(value)
  return result.success ? result.data : null
}

const SECTION_HEADING = /^(?:professional\s+)?(?:summary|profile|experience|employment(?:\s+history)?|work\s+history|education|skills|technical\s+skills|projects?|certifications?|achievements?|awards?)$/i
const EXPERIENCE_HEADING = /^(?:professional\s+)?(?:experience|employment(?:\s+history)?|work\s+history)$/i
const END_EXPERIENCE_HEADING = /^(?:education|skills|technical\s+skills|projects?|certifications?|achievements?|awards?)$/i
const SKILLS_HEADING = /^(?:(?:technical|core|key)\s+)?skills(?:\s*&\s*tools)?$/i
const JOB_TITLE = /(?:\b(?:software|frontend|front-end|backend|back-end|full[ -]?stack|web|mobile|ios|android|data|cloud|devops|platform|security|qa|test|product|project|program|engineering|technical|technology|solutions?|systems?|network|machine learning|ml|ai|ui|ux)\b.*\b(?:engineer|developer|architect|analyst|scientist|manager|lead|consultant|specialist|designer|administrator)\b)|(?:\b(?:engineer|developer|architect|analyst|scientist|manager|consultant|designer|administrator)\b.*\b(?:software|frontend|backend|data|product|project|program|engineering|technical|systems?|cloud|security|qa|ui|ux)\b)|^(?:founder|co-founder|intern|trainee|director|vice president|vp|head of [a-z ]+|chief [a-z ]+ officer)$/i
const DATE_RANGE = /\b((?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)?(?:19|20)\d{2})\s*(?:–|—|-|to)\s*((?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)?(?:19|20)\d{2}|present|current|now)\b/i
const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
}
const KNOWN_SKILLS = [
  'JavaScript',
  'TypeScript',
  'React',
  'Next.js',
  'Vue',
  'Angular',
  'Node.js',
  'Express',
  'NestJS',
  'Python',
  'Django',
  'Flask',
  'FastAPI',
  'Java',
  'Spring Boot',
  'Kotlin',
  'Swift',
  'C#',
  '.NET',
  'C++',
  'Go',
  'Rust',
  'Ruby',
  'Rails',
  'PHP',
  'Laravel',
  'SQL',
  'PostgreSQL',
  'MySQL',
  'MongoDB',
  'Redis',
  'DynamoDB',
  'GraphQL',
  'REST',
  'AWS',
  'Azure',
  'GCP',
  'Docker',
  'Kubernetes',
  'Terraform',
  'Jenkins',
  'GitHub Actions',
  'Linux',
  'Git',
  'Kafka',
  'RabbitMQ',
  'Spark',
  'Hadoop',
  'Pandas',
  'NumPy',
  'TensorFlow',
  'PyTorch',
  'scikit-learn',
  'Figma',
  'Jira',
  'Agile',
  'Scrum',
]

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.trim().toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function cleanLine(value: string): string {
  return value.replace(/^[•●▪◦*\-–—]\s*/, '').replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseDate(value: string): string | null {
  if (/^(?:present|current|now)$/i.test(value.trim())) return null
  const year = value.match(/(?:19|20)\d{2}/)?.[0]
  if (!year) return null
  const month = value.trim().slice(0, 3).toLowerCase()
  return `${year}-${MONTHS[month] ?? '01'}-01`
}

function monthsBetween(startedOn: string, endedOn: string | null): number {
  const start = new Date(`${startedOn}T00:00:00Z`)
  const end = endedOn ? new Date(`${endedOn}T00:00:00Z`) : new Date()
  return Math.max(0, (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth())
}

function findSection(lines: string[], heading: RegExp): [number, number] | null {
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (SECTION_HEADING.test(lines[index] ?? '')) {
      end = index
      break
    }
  }
  return [start + 1, end]
}

function extractSkills(lines: string[], text: string): string[] {
  const section = findSection(lines, SKILLS_HEADING)
  const explicit = section
    ? lines
        .slice(section[0], section[1])
        .flatMap((line) => line.split(/[,|;•●▪◦]/))
        .map(cleanLine)
        .filter((skill) => skill.length >= 2 && skill.length <= 60 && !DATE_RANGE.test(skill))
    : []

  const detected = KNOWN_SKILLS.filter((skill) => {
    const pattern = new RegExp(`(^|[^a-z0-9+#.])${escapeRegExp(skill.toLowerCase())}(?=$|[^a-z0-9+#.])`, 'i')
    return pattern.test(text)
  })
  return unique([...explicit, ...detected]).slice(0, 200)
}

function extractCompany(lines: string[], roleIndex: number, bounds: [number, number]): string | null {
  for (const index of [roleIndex + 1, roleIndex - 1, roleIndex + 2]) {
    if (index < bounds[0] || index >= bounds[1]) continue
    const candidate = cleanLine(lines[index] ?? '')
    if (
      !candidate ||
      candidate.length > 120 ||
      SECTION_HEADING.test(candidate) ||
      JOB_TITLE.test(candidate) ||
      DATE_RANGE.test(candidate) ||
      /@|https?:|www\./i.test(candidate)
    ) {
      continue
    }
    return candidate.replace(/[|,]+$/, '').trim()
  }
  return null
}

function extractEmployments(lines: string[]): ParsedEmployment[] {
  const start = lines.findIndex((line) => EXPERIENCE_HEADING.test(line))
  const bounds: [number, number] = [start >= 0 ? start + 1 : 0, lines.length]
  if (start >= 0) {
    for (let index = start + 1; index < lines.length; index += 1) {
      if (END_EXPERIENCE_HEADING.test(lines[index] ?? '')) {
        bounds[1] = index
        break
      }
    }
  }

  const rows: ParsedEmployment[] = []
  for (let index = bounds[0]; index < bounds[1]; index += 1) {
    const line = cleanLine(lines[index] ?? '')
    if (!JOB_TITLE.test(line)) continue

    const parts = line.split(/\s+(?:at|@)\s+|\s*[|•]\s*/i).map(cleanLine).filter(Boolean)
    const rolePart = parts.find((part) => JOB_TITLE.test(part)) ?? line
    const role = rolePart.replace(DATE_RANGE, '').replace(/[|,–—-]+$/, '').trim()
    let company = parts.find((part) => part !== rolePart && !DATE_RANGE.test(part)) ?? null
    company = company?.replace(DATE_RANGE, '').trim() || extractCompany(lines, index, bounds)
    if (!role || !company) continue

    let range: RegExpMatchArray | null = null
    for (let offset = 0; offset <= 3; offset += 1) {
      range = (lines[index + offset] ?? '').match(DATE_RANGE)
      if (range) break
    }
    const startedOn = range?.[1] ? parseDate(range[1]) : null
    const isCurrent = Boolean(range?.[2] && /^(?:present|current|now)$/i.test(range[2]))
    const endedOn = range?.[2] ? parseDate(range[2]) : null

    const bullets: string[] = []
    for (let offset = 1; offset <= 5; offset += 1) {
      const raw = lines[index + offset] ?? ''
      const candidate = cleanLine(raw)
      if (!candidate || JOB_TITLE.test(candidate) || SECTION_HEADING.test(candidate)) break
      if (/^[•●▪◦*\-–—]/.test(raw.trim()) && !DATE_RANGE.test(candidate)) bullets.push(candidate)
    }

    rows.push({
      role,
      company,
      startedOn,
      endedOn,
      isCurrent,
      blurb: bullets.length > 0 ? bullets.join(' ') : null,
    })
  }

  return rows.filter(
    (row, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.role.toLowerCase() === row.role.toLowerCase() &&
          candidate.company.toLowerCase() === row.company.toLowerCase(),
      ) === index,
  )
}

function extractContact(lines: string[], text: string): ParsedResume['contact'] {
  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] ?? null
  const phone =
    [...text.matchAll(/(?:\+?\d[\d \t().-]{7,}\d)/g)]
      .map((match) => match[0].replace(/[ \t]+/g, ' ').trim())
      .find((candidate) => {
        const digits = candidate.replace(/\D/g, '').length
        return digits >= 10 && digits <= 15
      }) ?? null
  const urls = [
    ...text.matchAll(/(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s|,;)]*)?/gi),
  ]
    .filter((match) => {
      const start = match.index ?? 0
      const end = start + match[0].length
      return text[start - 1] !== '@' && text[end] !== '@'
    })
    .map((match) => match[0])
  const linkedinUrl = urls.find((url) => /linkedin\.com\/in\//i.test(url)) ?? null
  const githubUrl = urls.find((url) => /github\.com\//i.test(url)) ?? null
  const portfolioUrl =
    urls.find((url) => !/linkedin\.com|github\.com/i.test(url)) ?? null
  const fullName =
    lines.slice(0, 8).find(
      (line) =>
        /^[\p{L}][\p{L} .'-]{2,80}$/u.test(line) &&
        line.split(/\s+/).length >= 2 &&
        line.split(/\s+/).length <= 6 &&
        !SECTION_HEADING.test(line) &&
        !JOB_TITLE.test(line),
    ) ?? null
  const explicitCity = text.match(/\b(?:city|location)\s*[:\-]\s*([\p{L} .'-]{2,80})/iu)?.[1]?.trim()
  const contactCity = lines
    .slice(0, 10)
    .map((line) => line.split(',')[0]?.trim() ?? '')
    .find((line, index) =>
      Boolean(
        lines[index]?.includes(',') &&
          /^[\p{L} .'-]{2,60}$/u.test(line) &&
          !SECTION_HEADING.test(line) &&
          line !== fullName,
      ),
    )

  return {
    fullName,
    email,
    phone,
    city: explicitCity ?? contactCity ?? null,
    linkedinUrl,
    githubUrl,
    portfolioUrl,
  }
}

export function parseResumeText(rawText: string): ParsedResume {
  const text = rawText.replace(/\r/g, '').replace(/\u0000/g, '').trim()
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const employments = extractEmployments(lines)
  const titles = unique(employments.map((row) => row.role))
  const explicitYears = text.match(/\b(\d{1,2})(?:\.\d+)?\+?\s+years?(?:\s+of)?\s+(?:professional\s+)?experience\b/i)
  const datedMonths = employments.reduce(
    (total, row) => total + (row.startedOn ? monthsBetween(row.startedOn, row.endedOn ?? null) : 0),
    0,
  )
  const yearsExperience = explicitYears
    ? Number(explicitYears[1])
    : datedMonths > 0
      ? Math.min(60, Math.max(1, Math.round(datedMonths / 12)))
      : null

  return {
    skills: extractSkills(lines, text),
    titles,
    yearsExperience,
    employments,
    contact: extractContact(lines, text),
    rawText: text,
  }
}

async function extractResumeText(request: ParseRequest): Promise<string> {
  if (!request.buffer) throw new Error('Resume bytes are unavailable for parsing.')
  const extension = request.fileName.split('.').pop()?.toLowerCase()

  if (request.mimeType === 'application/pdf' || extension === 'pdf') {
    const result = await extractText(new Uint8Array(request.buffer), { mergePages: true })
    return result.text
  }
  if (
    request.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    extension === 'docx'
  ) {
    const result = await mammoth.extractRawText({ buffer: request.buffer })
    return result.value
  }
  if (request.mimeType === 'text/plain' || extension === 'txt') {
    return request.buffer.toString('utf8')
  }
  throw new Error('Legacy .doc files cannot be parsed. Save the resume as PDF or DOCX.')
}

class DocumentResumeParser implements ResumeParser {
  readonly name = 'document-text'
  readonly isReal = true

  async parse(request: ParseRequest): Promise<ParsedResume> {
    const text = await extractResumeText(request)
    if (!text.trim()) throw new Error('No readable text was found in the resume.')
    return parseResumeText(text)
  }
}

let parser: ResumeParser = new DocumentResumeParser()

export function getResumeParser(): ResumeParser {
  return parser
}

/** Injection point for focused tests and future structured extractors. */
export function setResumeParser(next: ResumeParser): void {
  parser = next
  logger.info({ parser: next.name, isReal: next.isReal }, 'resume parser registered')
}
