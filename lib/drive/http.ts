import 'server-only'
import { DriveError } from './store'
import { DriveVolumeError } from './volumes'

/**
 * Drive's HTTP surface preserves the refusal status selected by the operation.
 * The same error code may represent different failures (for example, an
 * invalid request body or a well-formed write with duplicate paths).
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

export function driveErrorBody(error: DriveError): DriveErrorBody {
  const body: DriveErrorBody = { error: error.code }
  if (error.detail) {
    body.headDigest = error.detail.headDigest
    body.headVersionId = error.detail.headVersionId
    body.paths = error.detail.paths
  }
  return body
}

export function driveErrorResponse(error: unknown, headers?: HeadersInit): Response {
  if (error instanceof DriveError) return Response.json(driveErrorBody(error), { status: error.status, headers })
  if (error instanceof DriveVolumeError) return Response.json({ error: error.code }, { status: error.status, headers })
  throw error
}
