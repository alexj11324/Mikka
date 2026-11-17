import { driveResponse } from '@/lib/drive/server'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'

export const runtime = 'nodejs'

export const GET = freshSessionRoute(async (request: Request, context: { params: Promise<{ organizationId: string; volumeId: string; versionId: string; sha256: string }> }) =>
  governanceResponse(async () => driveResponse(request, 'organizationVersionFile', await context.params)))
