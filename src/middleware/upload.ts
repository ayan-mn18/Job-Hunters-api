import multer from 'multer'
import { env } from '../config/env.js'
import { badRequest } from '../lib/errors.js'

/**
 * Files are held in memory and streamed straight to Supabase Storage — they
 * never touch this machine's disk. Resumes are 5 MB at most, so the memory
 * cost is bounded and the "clean up the temp file" failure mode disappears.
 */

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
])

const ALLOWED_EXTENSIONS = /\.(pdf|doc|docx|txt)$/i

export const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_RESUME_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    // Check both: browsers lie about MIME type, and extensions are trivially
    // renamed. Requiring both to look sane is cheap.
    const mimeOk = ALLOWED_MIME_TYPES.has(file.mimetype)
    const extensionOk = ALLOWED_EXTENSIONS.test(file.originalname)
    if (mimeOk && extensionOk) return callback(null, true)
    callback(badRequest('Only PDF, DOC, DOCX or TXT resumes are accepted.'))
  },
})
