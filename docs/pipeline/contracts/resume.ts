/**
 * Resume engine contracts.
 *
 * The governing idea: the resume is structured data. A PDF is a *render* of
 * that data, never the source of truth. Everything here follows from that.
 *
 * See ../02-resume-engine.md for the reasoning.
 */

/* ------------------------------------------------------------------ base -- */

export type ISOMonth = `${number}-${number}` // "2024-01"

export interface ResumeBullet {
  /** Stable across edits and versions. Variants reference bullets by id. */
  id: string
  /**
   * The canonical wording, written by the user. A variant may reword this, but
   * the claim it makes is fixed here and may not be strengthened.
   */
  text: string
  /** Skills this bullet is genuine evidence for. Drives JD alignment scoring. */
  skills: string[]
  /**
   * Quantified outcomes as the user stated them ("p95 1.9s to 1.2s").
   * The tailoring step may drop a metric; it may never invent or inflate one.
   */
  metrics: string[]
  /** Optional user hint: never show this bullet, regardless of score. */
  suppressed?: boolean
}

export interface ResumeExperience {
  id: string
  company: string
  role: string
  location: string
  startDate: ISOMonth
  /** null = current role. */
  endDate: ISOMonth | null
  bullets: ResumeBullet[]
}

export interface ResumeEducation {
  id: string
  institution: string
  credential: string
  startDate: ISOMonth
  endDate: ISOMonth | null
  detail?: string
}

export interface ResumeSkill {
  id: string
  name: string
  /** Free-form grouping used for the skills line: "Frontend", "Data", … */
  category: string
  yearsUsed?: number
  /** Set true only by the user, never by the model. */
  primary?: boolean
}

export interface ResumeProject {
  id: string
  name: string
  url?: string
  description: string
  skills?: string[]
}

export interface ResumeBasics {
  fullName: string
  headline: string
  email: string
  phone: string
  location: { city: string; region?: string; country: string }
  links: { label: string; url: string }[]
}

/**
 * The single source of truth for the user's career. Uploaded once (parsed from
 * a PDF, then confirmed by the user in the UI), edited in the UI thereafter.
 * Every rendered PDF in the system is derived from one version of this.
 */
export interface ResumeDocument {
  id: string
  /** Monotonic. Bumped on every user edit. Variants pin a version. */
  version: number
  locale: string
  basics: ResumeBasics
  summary: { id: string; text: string }
  experience: ResumeExperience[]
  education: ResumeEducation[]
  skills: ResumeSkill[]
  projects: ResumeProject[]
  /** sha256 of the canonical JSON serialisation. Cheap change detection. */
  contentHash?: string
}

/* --------------------------------------------------------------- ingest -- */

export type ResumeIngestSource = 'pdf' | 'docx' | 'latex' | 'linkedin' | 'manual'

/**
 * Output of parsing an uploaded file into a draft ResumeDocument. Always shown
 * to the user for confirmation before it becomes the base — parsing is
 * lossy and the user is the only one who can say what is true.
 */
export interface ResumeIngestResult {
  source: ResumeIngestSource
  draft: ResumeDocument
  /** Per-field confidence, 0..1. Anything under 0.8 is flagged in the UI. */
  confidence: Record<string, number>
  /** Raw extracted text, kept for one-off diffing when a parse looks wrong. */
  rawText: string
  warnings: string[]
}

/* -------------------------------------------------------------- job desc -- */

export interface JobDescriptionSnapshot {
  id: string
  jobId: string
  /** Plain text as scraped. This is the evidence for what we tailored against. */
  text: string
  /** sha256 of `text`. Identical postings across portals collapse to one hash. */
  textHash: string
  capturedAt: string
  sourceUrl: string
}

/**
 * Extracted requirements. Produced once per JD and cached by `textHash`, so
 * the same posting re-scraped from another portal costs nothing.
 */
export interface JDAnalysis {
  jdHash: string
  title: string
  seniority: 'intern' | 'junior' | 'mid' | 'senior' | 'staff' | 'lead' | 'unknown'
  /** Skills the JD names, normalised to the same vocabulary as ResumeSkill.name. */
  requiredSkills: string[]
  preferredSkills: string[]
  /** Verbatim phrases worth mirroring in the summary if they are true. */
  keyPhrases: string[]
  responsibilities: string[]
  dealBreakers: string[]
  yearsRequired?: number
}

/* ------------------------------------------------------------- tailoring -- */

export interface TailoringRequest {
  requestId: string
  userId: string
  /** The base document, pinned to a version. */
  base: ResumeDocument
  baseVersion: number
  jd: JDAnalysis
  jdSnapshotId: string
  /** Layout the variant will be rendered with; constrains the length budget. */
  templateId: string
  constraints: TailoringConstraints
}

export interface TailoringConstraints {
  /** Hard cap. One page unless the user says otherwise. */
  maxPages: 1 | 2
  /** Total bullets across all roles the layout can fit. */
  maxBullets: number
  /** Bullets to keep for the most recent role, minimum. */
  minBulletsPerRole: number
  /**
   * Hard rule, enforced in code as well as in the prompt. When true the model
   * may reorder, select and reword; it may not add an employer, a date, a
   * credential, a metric or a skill that is not in `base`.
   */
  noNewFacts: true
}

/**
 * The tailoring model's only legal output. Note what it cannot express: there
 * is no field for a new employer, a new date range or a new skill. The schema
 * is the first line of fabrication defence — the model literally has no slot
 * to put an invented job in.
 */
export interface TailoringPlan {
  /** Rewritten summary. Must be supported by bullets in `base`. */
  summary: { text: string; supportingBulletIds: string[] }
  /** Ordered. Roles omitted here are dropped from the render. */
  experienceOrder: {
    experienceId: string
    /** Ordered subset of that role's bullet ids. Ids must exist in `base`. */
    bulletIds: string[]
  }[]
  /**
   * Optional rewordings, keyed by an existing bullet id. `text` must preserve
   * every metric in the source bullet and may not add a new one.
   */
  bulletRewrites: Record<string, string>
  /** Ordered subset of existing skill ids. No new names. */
  skillOrder: string[]
  /** Ordered subset of existing project ids. */
  projectOrder: string[]
  /** Model's own account of the alignment. Shown in the UI, not trusted. */
  rationale: string
}

/** Machine-checkable reasons a plan is rejected before it can be rendered. */
export type FabricationViolation =
  | { kind: 'unknown_bullet_id'; id: string }
  | { kind: 'unknown_experience_id'; id: string }
  | { kind: 'unknown_skill_id'; id: string }
  | { kind: 'unknown_project_id'; id: string }
  | { kind: 'metric_dropped'; bulletId: string; metric: string }
  | { kind: 'metric_invented'; bulletId: string; metric: string }
  | { kind: 'metric_inflated'; bulletId: string; was: string; now: string }
  | { kind: 'employer_invented'; company: string }
  | { kind: 'date_changed'; experienceId: string }
  | { kind: 'skill_invented'; skill: string }
  | { kind: 'entity_invented'; entity: string; field: string }
  | { kind: 'semantic_drift'; bulletId: string; similarity: number }

export interface TailoringResult {
  requestId: string
  plan: TailoringPlan
  violations: FabricationViolation[]
  /** Only a plan with zero violations may be rendered. */
  accepted: boolean
  model: string
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }
  latencyMs: number
}

/* --------------------------------------------------------------- variant -- */

/**
 * The permanent record of "what we sent". Small, structured, no binary.
 * A PDF can be regenerated from this plus the pinned base version.
 */
export interface ResumeVariant {
  id: string
  userId: string
  applicationId: string
  baseResumeId: string
  baseResumeVersion: number
  jdSnapshotId: string
  jdHash: string
  templateId: string
  /** Pinned renderer image digest. Reproducibility is only valid per renderer. */
  rendererVersion: string
  /** The plan is the diff. Everything else is derivable. */
  plan: TailoringPlan
  /** sha256 of the rendered PDF with /CreationDate and /ModDate blanked. */
  contentHash: string
  atsReport: AtsReport
  /** Human-facing filename that was actually uploaded to the portal. */
  fileName: string
  sizeBytes: number
  createdAt: string
  /**
   * Set once the ephemeral PDF has been deleted. `null` means a copy is still
   * in object storage (in-flight, or explicitly pinned by the user).
   */
  pdfDeletedAt: string | null
  /** True when the user pinned this variant; exempt from the cleanup job. */
  pinned: boolean
}

/* ------------------------------------------------------------ ats report -- */

export type AtsCheckId =
  | 'contact'
  | 'headings'
  | 'readingOrder'
  | 'attribution'
  | 'keywords'
  | 'pageArtifacts'
  | 'pageCount'
  | 'fontEmbedding'

export interface AtsCheck {
  id: AtsCheckId
  pass: boolean
  detail: string
}

/**
 * Produced by re-parsing the rendered PDF. This is a gate, not a vanity metric:
 * a variant that fails a blocking check is never uploaded.
 */
export interface AtsReport {
  /** 0..100. Weighted, but the gate is `blockingFailures.length === 0`. */
  score: number
  checks: AtsCheck[]
  blockingFailures: AtsCheckId[]
  /** Share of `JDAnalysis.requiredSkills` recoverable from the extracted text. */
  requiredSkillCoverage: number
  extractedChars: number
  pages: number
}

/* ---------------------------------------------------------------- render -- */

export interface RenderRequest {
  variantId: string
  base: ResumeDocument
  plan: TailoringPlan
  templateId: string
}

export interface RenderResult {
  variantId: string
  /** Local path on the worker. Never a Supabase Storage URL by default. */
  localPath: string
  contentHash: string
  sizeBytes: number
  pages: number
  atsReport: AtsReport
}
