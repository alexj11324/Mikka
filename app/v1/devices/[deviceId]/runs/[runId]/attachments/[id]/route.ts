import { z } from 'zod'
import { pool } from '@/lib/db'
import { withDeviceRoute } from '@/lib/device-route'
import { authenticateDevice } from '@/lib/device-link'
import { isDeviceAuthorityError } from '@/lib/db/device-scope'
import { authorizeFileScope, chatFileBytes, fileScope, readChatFile } from '@/lib/chat-attachments/store'

export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }
async function handleGET(
  request: Request,
  context: { params: Promise<{ deviceId: string; runId: string; id: string }> },
) {
  const actor = await authenticateDevice(request)
  if (!actor) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  const parsed = z
    .object({ deviceId: z.uuid(), runId: z.uuid(), id: z.uuid() })
    .safeParse(await context.params)
  if (!parsed.success || (actor.scopeDeviceId && actor.scopeDeviceId !== parsed.data.deviceId))
    return Response.json({ error: 'Unavailable' }, { status: 404, headers })
  const { deviceId, runId, id } = parsed.data
  const run = (
    await pool.query<{ prompt: string }>(
      `SELECT r.prompt FROM agent_runs r
    JOIN devices d ON d.id=r."deviceId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3 AND d."ownerId"=$2 AND d.enabled=true AND d."removedAt" IS NULL
      AND (r."deviceTokenId" IS NULL OR r."deviceTokenId"=$4) AND r.status IN ('preparing','running','waiting_input','paused')
      AND (position($5 in r.prompt)>0 OR EXISTS(SELECT 1 FROM run_messages m WHERE m."runId"=r.id AND m."userId"=$2 AND position($5 in m.text)>0))`,
      [runId, actor.userId, deviceId, actor.tokenId, `[mikka-file:${id}:`],
    )
  ).rows[0]
  if (!run) return Response.json({ error: 'Unavailable' }, { status: 404, headers })
  try {
    const workspace = await authorizeFileScope(actor.userId, { kind: 'thread', id: runId })
    if (actor.scopeWorkspaceId && actor.scopeWorkspaceId !== workspace) throw Error('scope')
    const file = await readChatFile(actor.userId, id)
    if ((await authorizeFileScope(actor.userId, fileScope(file))) !== workspace) throw Error('scope')
    if (!file.usedAt) return Response.json({ error: 'Unavailable' }, { status: 404, headers })
    const data = Buffer.from(await chatFileBytes(file)).toString('base64')
    await readChatFile(actor.userId, id)
    return Response.json(
      {
        id: file.id,
        name: file.name,
        mediaType: file.mediaType,
        size: file.size,
        sha256: file.sha256,
        data,
        text: file.textContent,
      },
      { headers },
    )
  } catch (error) {
    if (isDeviceAuthorityError(error)) throw error
    return Response.json({ error: 'Unavailable' }, { status: 404, headers })
  }
}
export const GET = withDeviceRoute(handleGET)
