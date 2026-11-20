import { interopApi, limitParam, param } from '@/lib/interop/http'
import { listThreads } from '@/lib/interop/threads'

/** Threads in the credential's Workspace it may read (decision 2026-11-19-2200). */
export const GET = (request: Request) => interopApi(request, 'threads:read', async principal =>
  ({ threads: await listThreads(principal, { issueId: param(request, 'issueId'), limit: limitParam(request) }) }))
