import 'server-only'
import { DriveError } from './store'

/**
 * Drive's HTTP surface: one place that decides a status and a body for every
 * error the store can raise, so a route never invents its own mapping and a
 * client never has to parse an error message.
 *
 * A version conflict is the case that matters: it is a 409 with
 * `{ error, headDigest, headVersionId, paths }`. A client that reads only the
 * status knows it lost the race; a client that reads the body knows which files
 * to re-read and which tree to base its retry on.
 */
export interface DriveErrorBody {
  error: string
  headDigest?: string
  headVersionId?: string
  paths?: string[]
}

export const DRIVE_ERROR_CODES = [
  'drive_not_found', 'drive_scope_invalid', 'drive_limit_exceeded', 'drive_version_conflict',
  'drive_replay_mismatch', 'drive_blob_unknown', 'drive_blob_size_mismatch', 'drive_manifest_invalid',
  'drive_write_invalid',
] as const

export function driveErrorStatus(error: DriveError): number {
  switch (error.code) {
    case 'drive_not_found': return 404
    case 'drive_write_invalid': return 400
    case 'drive_version_conflict': return 409
    case 'drive_replay_mismatch': return 409
    case 'drive_limit_exceeded': return 413
    default: return 422
  }
}

export function driveErrorBody(error: DriveError): DriveErrorBody {
  const body: DriveErrorBody = { error: error.code }
  if (error.detail) {
    body.headDigest = error.detail.headDigest
    body.headVersionId = error.detail.headVersionId
    body.paths = error.detail.paths
  }
  return body
}

/** A Response for any error a Drive route can throw, so a route stays three lines. */
export function driveErrorResponse(error: unknown): Response {
  if (error instanceof DriveError) return Response.json(driveErrorBody(error), { status: driveErrorStatus(error) })
  throw error
}

/** Whether `code` is one this module knows, for a client's own error handling. */
export function isDriveErrorCode(code: unknown): code is string {
  return typeof code === 'string' && (DRIVE_ERROR_CODES as readonly string[]).includes(code)
}
