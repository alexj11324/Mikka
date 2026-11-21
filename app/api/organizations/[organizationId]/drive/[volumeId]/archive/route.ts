import { driveResponse } from '@/lib/drive/server'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'

export const runtime = 'nodejs'

export const POST = freshSessionRoute(async (request: Request, context: { params: Promise<{ organizationId: string; volumeId: string }> }) =>
  governanceResponse(async () => driveResponse(request, 'archive', await context.params)))
