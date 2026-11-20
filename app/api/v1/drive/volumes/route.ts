import { InteropError } from '@/lib/interop/errors'
import { interopApi, interopBody, param } from '@/lib/interop/http'
import { interopAuthor } from '@/lib/interop/tools'
import { listInteropDrive, writeInteropDriveFile } from '@/lib/interop/drive'

/** A shared Drive scope's folders and its default folder's files (decision 2026-11-19-2200 §4). */
export const GET = (request: Request) => interopApi(request, 'drive:read', principal => {
  const scope = param(request, 'scope')
  if (!scope) throw new InteropError('interop_invalid_request')
  return listInteropDrive(principal, { scope, scopeId: param(request, 'scopeId'), prefix: param(request, 'prefix') })
})

/** Write one file into the scope's default folder, creating it on the first write (body names scope and scopeId). */
export const PUT = (request: Request) => interopApi(request, 'drive:write', async principal =>
  writeInteropDriveFile(principal, await interopBody(request), interopAuthor(principal)))
