import { InteropError } from '@/lib/interop/errors'
import { interopApi, param } from '@/lib/interop/http'
import { listInteropDrive } from '@/lib/interop/drive'

/** A shared Drive scope's folders and its default folder's files (decision 2026-11-19-2200 §4). */
export const GET = (request: Request) => interopApi(request, 'drive:read', principal => {
  const scope = param(request, 'scope')
  if (!scope) throw new InteropError('interop_invalid_request')
  return listInteropDrive(principal, { scope, scopeId: param(request, 'scopeId'), prefix: param(request, 'prefix') })
})
