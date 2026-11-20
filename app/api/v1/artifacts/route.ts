import { interopApi, limitParam, param } from '@/lib/interop/http'
import { listInteropArtifacts } from '@/lib/interop/artifacts'

/** Artifacts of the credential's Workspace it may read (decision 2026-11-19-2200). */
export const GET = (request: Request) => interopApi(request, 'artifacts:read', async principal =>
  ({ artifacts: await listInteropArtifacts(principal, { runId: param(request, 'runId'), issueId: param(request, 'issueId'), limit: limitParam(request) }) }))
