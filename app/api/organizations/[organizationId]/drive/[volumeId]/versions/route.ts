import { driveResponse } from '@/lib/drive/server'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'


export const GET = freshSessionRoute(async (request: Request, context: { params: Promise<{ organizationId: string; volumeId: string }> }) =>
  governanceResponse(async () => driveResponse(request, 'history', await context.params)))
