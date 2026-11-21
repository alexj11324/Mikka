import { driveResponse } from '@/lib/drive/server'
import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse } from '@/lib/governance/http'


type Context = { params: Promise<{ organizationId: string; shareId: string }> }

const manage = freshSessionRoute(async (request: Request, context: Context) =>
  governanceResponse(async () => driveResponse(request, 'shareView', await context.params)))

export { manage as PATCH, manage as DELETE }
