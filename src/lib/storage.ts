import crypto from 'node:crypto'
import path from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env, hasSupabaseStorage } from '../config/env.js'
import { logger } from './logger.js'
import { serviceUnavailable } from './errors.js'

/**
 * Supabase Storage, for base resumes, generated variants, and resumes that
 * arrive attached to a referral request.
 *
 * The bucket must be PRIVATE. Downloads go out as short-lived signed URLs
 * minted per request; nothing in here is ever public.
 *
 * As with the database, the client is lazy — the project does not exist yet,
 * and the server has to boot without it.
 */

let client: SupabaseClient | undefined

function getClient(): SupabaseClient {
  if (!hasSupabaseStorage) {
    throw serviceUnavailable(
      'Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    )
  }
  if (!client) {
    client = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return client
}

export interface StoredObject {
  path: string
  fileName: string
  mimeType: string
  sizeBytes: number
}

/** Strip anything that could escape the key namespace or confuse a CDN. */
export function sanitiseFileName(original: string): string {
  const base = path.basename(original)
  const cleaned = base.replace(/[^\w.\-—]+/g, '-').replace(/-{2,}/g, '-')
  return cleaned.slice(0, 180) || 'resume.pdf'
}

/**
 * Keys are `<userId>/<kind>/<uuid>-<name>`. The user id prefix means a future
 * storage RLS policy can be written as a simple path check, and it keeps one
 * user's objects from ever colliding with another's.
 */
export function buildObjectKey(userId: string, kind: string, fileName: string): string {
  return `${userId}/${kind}/${crypto.randomUUID()}-${sanitiseFileName(fileName)}`
}

export async function uploadObject(params: {
  key: string
  body: Buffer
  mimeType: string
  upsert?: boolean
}): Promise<void> {
  const { error } = await getClient()
    .storage.from(env.SUPABASE_STORAGE_BUCKET)
    .upload(params.key, params.body, {
      contentType: params.mimeType,
      upsert: params.upsert ?? false,
    })

  if (error) {
    logger.error({ err: error, key: params.key }, 'supabase storage upload failed')
    throw serviceUnavailable(`Could not store the file: ${error.message}`)
  }
}
export async function downloadObject(key: string): Promise<Buffer> {
  const { data, error } = await getClient()
    .storage.from(env.SUPABASE_STORAGE_BUCKET)
    .download(key)

  if (error || !data) {
    logger.error({ err: error, key }, 'supabase storage download failed')
    throw serviceUnavailable(`Could not read the stored file: ${error?.message ?? 'unknown'}`)
  }
  return Buffer.from(await data.arrayBuffer())
}


export async function createSignedUrl(
  key: string,
  expiresIn = env.SUPABASE_SIGNED_URL_TTL,
): Promise<string> {
  const { data, error } = await getClient()
    .storage.from(env.SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(key, expiresIn)

  if (error || !data) {
    logger.error({ err: error, key }, 'supabase signed url failed')
    throw serviceUnavailable(`Could not create a download link: ${error?.message ?? 'unknown'}`)
  }
  return data.signedUrl
}

/** Best-effort: a failed cleanup should never fail the user's request. */
export async function removeObject(key: string): Promise<void> {
  try {
    const { error } = await getClient().storage.from(env.SUPABASE_STORAGE_BUCKET).remove([key])
    if (error) logger.warn({ err: error, key }, 'supabase storage delete failed')
  } catch (error) {
    logger.warn({ err: error, key }, 'supabase storage delete threw')
  }
}

export const storageConfigured = () => hasSupabaseStorage
export const storageBucket = env.SUPABASE_STORAGE_BUCKET
