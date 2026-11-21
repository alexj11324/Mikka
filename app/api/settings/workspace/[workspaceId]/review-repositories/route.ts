import { getCodeReviewRepositories, saveCodeReviewRepository, deleteCodeReviewRepository } from '@/app/actions/review-settings'
import { settingsBody, settingsResponse } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'

type Context = { params: Promise<{ workspaceId: string }> }
export const GET = withRequestLog('/api/settings/workspace/[workspaceId]/review-repositories', (_request: Request, context: Context) =>
  settingsResponse(async () => getCodeReviewRepositories((await context.params).workspaceId)))
export const PATCH = freshSessionRoute(withRequestLog('/api/settings/workspace/[workspaceId]/review-repositories', (request: Request, context: Context) =>
  settingsResponse(async () => saveCodeReviewRepository((await context.params).workspaceId, await settingsBody(request)))))
export const DELETE = freshSessionRoute(withRequestLog('/api/settings/workspace/[workspaceId]/review-repositories', (request: Request, context: Context) =>
  settingsResponse(async () => deleteCodeReviewRepository((await context.params).workspaceId, await settingsBody(request)))))
