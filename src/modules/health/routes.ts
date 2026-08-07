import { Router } from 'express'
import {
  env,
  hasDatabase,
  hasPortalCredentialVault,
  hasRedis,
  hasSupabaseStorage,
} from '../../config/env.js'
import { pingDatabase } from '../../db/client.js'
import { asyncHandler } from '../../lib/http.js'
import { getReferralDraftGenerator } from '../../services/referral-draft.js'
import { getResumeParser } from '../../services/resume-parser.js'

export const healthRouter: Router = Router()

const startedAt = Date.now()

/**
 * Liveness. Answers 200 as long as the process is up, deliberately without
 * touching the database — a load balancer restarting the API because Postgres
 * blinked would turn one outage into two.
 */
healthRouter.get('/healthz', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  })
})

/**
 * Readiness. This one does check dependencies, and reports honestly on what is
 * configured and what is still a stub — it is the fastest way to answer "why
 * is nothing happening" on a fresh checkout.
 */
healthRouter.get(
  '/readyz',
  asyncHandler(async (_req, res) => {
    const database = await pingDatabase()
    const parser = getResumeParser()
    const draftGenerator = getReferralDraftGenerator()

    const ready = database.ok

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      checks: {
        database: {
          configured: hasDatabase,
          ok: database.ok,
          ...(database.error ? { error: database.error } : {}),
        },
        storage: {
          configured: hasSupabaseStorage,
          bucket: env.SUPABASE_STORAGE_BUCKET,
        },
        queue: { configured: hasRedis },
        portalCredentialVault: { configured: hasPortalCredentialVault },
        portalAutomation: {
          enabled: env.PORTAL_AUTOMATION_ENABLED,
          chromiumConfigured: Boolean(env.CHROMIUM_EXECUTABLE_PATH),
        },
      },
      stubs: {
        resumeParser: { name: parser.name, implemented: parser.isReal },
        referralDraftGenerator: { name: draftGenerator.name, implemented: draftGenerator.isReal },
        huntPipeline: { implemented: true, queueConfigured: hasRedis },
      },
      timestamp: new Date().toISOString(),
    })
  }),
)
