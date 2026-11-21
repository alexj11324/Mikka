import { InteropError } from '@/lib/interop/errors'
import { interopApi, param } from '@/lib/interop/http'
import { readInteropArtifact } from '@/lib/interop/artifacts'

type Context = { params: Promise<{ artifactId: string }> }

/** One artifact version's content, the latest unless `version` is given. */
export const GET = async (request: Request, { params }: Context) => {
  const { artifactId } = await params
  return interopApi(request, 'artifacts:read', principal => {
    const raw = param(request, 'version')
    const version = raw === undefined ? undefined : Number(raw)
    if (version !== undefined && !Number.isInteger(version)) throw new InteropError('interop_invalid_request')
    return readInteropArtifact(principal, artifactId, version)
  })
}
