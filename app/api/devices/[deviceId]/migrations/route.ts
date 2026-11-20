import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceMutationSession, governanceResponse } from '@/lib/governance/http'
import { deviceMigrationInput, inspectDeviceMigration } from '@/lib/settings/device-detail'

export const POST = freshSessionRoute(async (request: Request, { params }: { params: Promise<{ deviceId: string }> }) => governanceResponse(async () => {
  const { deviceId } = await params
  const input = deviceMigrationInput.parse(await governanceJson(request))
  const session = await governanceMutationSession(request, input.workspaceId)
  const result = await inspectDeviceMigration(session.user, deviceId, input)
  return Response.json(result, { status: 409, headers: { 'cache-control': 'private, no-store' } })
}))
