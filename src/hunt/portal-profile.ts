import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { employments, kits, resumes } from '../db/schema.js'
import { badRequest } from '../lib/errors.js'
import { readParsedResume } from '../services/resume-parser.js'
import { resumeDocumentSchema, type ResumeDocument } from './resume-document.js'

export interface PortalProfile {
  fullName: string
  email: string
  phone: string
  headline: string
  address: {
    line1: string
    line2: string
    city: string
    region: string
    postalCode: string
    country: string
  }
  links: {
    linkedin: string
    github: string
    portfolio: string
  }
  noticePeriod: string
  currentCtc: string
  expectedCtc: string
  workAuthorization: string
  willingToRelocate: string
  skills: string[]
  experience: Array<{
    role: string
    company: string
    startedOn: string | null
    endedOn: string | null
    isCurrent: boolean
    description: string
  }>
  photoStoragePath: string | null
  photoFileName: string | null
  baseResume: {
    id: string
    fileName: string
    storagePath: string
    mimeType: string
  }
  resumeDocument: ResumeDocument | null
}

export async function loadPortalProfile(userId: string): Promise<PortalProfile> {
  const [[kit], [baseResume], history] = await Promise.all([
    db.select().from(kits).where(eq(kits.userId, userId)).limit(1),
    db.select().from(resumes).where(and(eq(resumes.userId, userId), eq(resumes.isBase, true))).limit(1),
    db.select().from(employments).where(eq(employments.userId, userId)).orderBy(asc(employments.sortOrder)),
  ])
  if (!kit) throw badRequest('Complete My Kit before creating portal profiles.')
  if (!baseResume) throw badRequest('Upload a base resume before creating portal profiles.')
  if (!kit.fullName || !kit.email || !kit.phone) {
    throw badRequest('Full name, application email, and phone are required in My Kit.')
  }

  const structured = resumeDocumentSchema.safeParse(baseResume.structuredDocument)
  const parsed = readParsedResume(baseResume.parsedProfile)
  const skills = [...new Set([...(kit.skills ?? []), ...(parsed?.skills ?? [])])]

  return {
    fullName: kit.fullName,
    email: kit.email,
    phone: kit.phone,
    headline: kit.headline ?? parsed?.titles[0] ?? '',
    address: {
      line1: kit.addressLine1 ?? '',
      line2: kit.addressLine2 ?? '',
      city: kit.city ?? '',
      region: kit.state ?? '',
      postalCode: kit.postalCode ?? '',
      country: kit.country ?? '',
    },
    links: {
      linkedin: kit.linkedinUrl ?? '',
      github: kit.githubUrl ?? '',
      portfolio: kit.portfolioUrl ?? '',
    },
    noticePeriod: kit.noticePeriod ?? '',
    currentCtc: kit.currentCtc ?? '',
    expectedCtc: kit.expectedCtc ?? '',
    workAuthorization: kit.workAuthorization ?? '',
    willingToRelocate: kit.willingToRelocate ?? '',
    skills,
    experience: history.map((employment) => ({
      role: employment.role,
      company: employment.company,
      startedOn: employment.startedOn,
      endedOn: employment.endedOn,
      isCurrent: employment.isCurrent,
      description: employment.blurb ?? '',
    })),
    photoStoragePath: kit.photoStoragePath,
    photoFileName: kit.photoFileName,
    baseResume: {
      id: baseResume.id,
      fileName: baseResume.fileName,
      storagePath: baseResume.storagePath,
      mimeType: baseResume.mimeType,
    },
    resumeDocument: structured.success ? structured.data : null,
  }
}
