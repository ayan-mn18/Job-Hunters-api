import crypto from 'node:crypto'
import { z } from 'zod'
import type { ParsedResume } from '../services/resume-parser.js'

const bulletSchema = z.object({
  id: z.string().min(1).max(120),
  text: z.string().trim().min(1).max(2000),
  skills: z.array(z.string().trim().min(1).max(80)).max(100),
})

const experienceSchema = z.object({
  id: z.string().min(1).max(120),
  role: z.string().trim().min(1).max(200),
  company: z.string().trim().min(1).max(200),
  startedOn: z.string().nullable(),
  endedOn: z.string().nullable(),
  isCurrent: z.boolean(),
  bullets: z.array(bulletSchema).max(50),
})

export const resumeDocumentSchema = z.object({
  version: z.number().int().positive(),
  basics: z.object({
    fullName: z.string().trim().max(200),
    email: z.string().trim().max(254),
    phone: z.string().trim().max(80),
    city: z.string().trim().max(120),
    headline: z.string().trim().max(240),
    links: z.array(z.object({ label: z.string().max(80), url: z.string().max(500) })).max(20),
  }),
  summary: z.string().trim().max(3000),
  skills: z.array(z.object({
    id: z.string().min(1).max(120),
    name: z.string().trim().min(1).max(80),
  })).max(300),
  experience: z.array(experienceSchema).max(100),
})

export type ResumeDocument = z.infer<typeof resumeDocumentSchema>

function stableId(prefix: string, value: string, index: number): string {
  const hash = crypto.createHash('sha256').update(`${value}:${index}`).digest('hex').slice(0, 12)
  return `${prefix}_${hash}`
}

export function buildResumeDocument(parsed: ParsedResume): ResumeDocument {
  const skills = parsed.skills.map((name, index) => ({ id: stableId('skill', name, index), name }))
  const links = [
    parsed.contact.linkedinUrl ? { label: 'LinkedIn', url: parsed.contact.linkedinUrl } : null,
    parsed.contact.githubUrl ? { label: 'GitHub', url: parsed.contact.githubUrl } : null,
    parsed.contact.portfolioUrl ? { label: 'Portfolio', url: parsed.contact.portfolioUrl } : null,
  ].filter((link): link is { label: string; url: string } => link !== null)

  return {
    version: 1,
    basics: {
      fullName: parsed.contact.fullName ?? '',
      email: parsed.contact.email ?? '',
      phone: parsed.contact.phone ?? '',
      city: parsed.contact.city ?? '',
      headline: parsed.titles[0] ?? '',
      links,
    },
    summary: '',
    skills,
    experience: parsed.employments.map((employment, index) => {
      const key = `${employment.company}:${employment.role}`
      const bullets = employment.blurb
        ? [{
            id: stableId('bullet', `${key}:${employment.blurb}`, 0),
            text: employment.blurb,
            skills: parsed.skills.filter((skill) => employment.blurb?.toLowerCase().includes(skill.toLowerCase())),
          }]
        : []
      return {
        id: stableId('experience', key, index),
        role: employment.role,
        company: employment.company,
        startedOn: employment.startedOn ?? null,
        endedOn: employment.endedOn ?? null,
        isCurrent: employment.isCurrent ?? false,
        bullets,
      }
    }),
  }
}
