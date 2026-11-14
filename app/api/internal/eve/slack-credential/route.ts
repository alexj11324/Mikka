import { z } from 'zod'
import { validSlackGrantProof } from '@/lib/slack/grant-proof'
import { internalEveRequestScope } from '@/lib/eve/auth'
import { assertEveScope } from '@/lib/eve/scope'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { pool } from '@/lib/db'
import { installationCredential } from '@/lib/slack/installation-store'
import { slackTeamId, slackUserId } from '@/lib/slack/install-provider'
import { withRequestLog } from '@/lib/request-log'

export const runtime = 'nodejs'
const shape = z
  .object({
    installationId: z.uuid(),
    linkId: z.uuid(),
    teamId: z.string().refine(slackTeamId),
    slackUserId: z.string().refine(slackUserId),
  })
  .strict()
async function handle(request: Request) {
  const refuse = () => new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  const scope = internalEveRequestScope(request),
    app = process.env.SLACK_APP_ID
  if (scope?.surface !== 'slack' || !app) return refuse()
  try {
    const input = shape.safeParse(await request.json())
    if (
      !input.success ||
      !validSlackGrantProof(
        request.headers.get('authorization') ?? request.headers.get('x-mikka-eve-binding-scope')!,
        input.data,
        request.headers.get('x-mikka-slack-grant'),
      )
    )
      return refuse()
    await assertEveScope(scope)
    const token = await withTaskWorkspace(scope.ownerId, scope.workspaceId, () =>
      installationCredential(pool, {
        app,
        owner: scope.ownerId,
        workspace: scope.workspaceId,
        team: input.data.teamId,
        sender: input.data.slackUserId,
        installationId: input.data.installationId,
        linkId: input.data.linkId,
      }),
    )
    return Response.json({ token }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return refuse()
  }
}
export const POST = withRequestLog('/api/internal/eve/slack-credential', handle)
