import { InteropError } from '@/lib/interop/errors'
import { interopApi, interopBody, param, volumeScope } from '@/lib/interop/http'
import { interopAuthor } from '@/lib/interop/tools'
import { listInteropDrive, readInteropDriveFile, writeInteropDriveFile } from '@/lib/interop/drive'

type Context = { params: Promise<{ volumeId: string }> }

/** One file (`?path=`), or the folder's files at its head when no path is given. */
export const GET = async (request: Request, { params }: Context) => {
  const { volumeId } = await params
  return interopApi(request, 'drive:read', async principal => {
    const target = await volumeScope(principal, volumeId)
    const path = param(request, 'path')
    if (path === undefined) return listInteropDrive(principal, { ...target, prefix: param(request, 'prefix') })
    const encoding = param(request, 'encoding')
    if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') throw new InteropError('interop_invalid_request')
    return readInteropDriveFile(principal, { ...target, path, encoding }, request.signal)
  })
}

/** Write or delete one file with the folder's compare-and-swap (`expectedDigest`). */
export const PUT = async (request: Request, { params }: Context) => {
  const { volumeId } = await params
  return interopApi(request, 'drive:write', async principal => {
    const target = await volumeScope(principal, volumeId)
    const body = await interopBody(request)
    return writeInteropDriveFile(principal, { ...body, ...target }, interopAuthor(principal))
  })
}
