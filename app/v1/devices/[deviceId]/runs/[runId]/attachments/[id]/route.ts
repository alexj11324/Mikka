import { z } from 'zod'
import { CHAT_FILE_CHUNK_BYTES } from '@mikka/protocol/chat-attachments'
import { pool } from '@/lib/db'
import { withDeviceRoute } from '@/lib/device-route'
import { authenticateDevice } from '@/lib/device-link'
import { isDeviceAuthorityError } from '@/lib/db/device-scope'
import {
  chatFileBytes,
  readChatFileForRun,
} from '@/lib/chat-attachments/store'

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
    await pool.query<{ workspaceId: string; actorId: string }>(
      `SELECT r."workspaceId",coalesce(r."agentDefinition"->'executionIdentity'->>'actor',r."userId") AS "actorId" FROM agent_runs r
    JOIN devices d ON d.id=r."deviceId"
    WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3 AND d."ownerId"=$2 AND d.enabled=true AND d."removedAt" IS NULL
      AND (r."deviceTokenId" IS NULL OR r."deviceTokenId"=$4) AND r.status IN ('preparing','running','waiting_input','finishing')`,
      [runId, actor.userId, deviceId, actor.tokenId],
    )
  ).rows[0]
  if (!run) return Response.json({ error: 'Unavailable' }, { status: 404, headers })
  try {
    if (!run.workspaceId || actor.scopeWorkspaceId && actor.scopeWorkspaceId !== run.workspaceId) throw Error('scope')
    const authority={runId,executionOwnerId:actor.userId,actorId:run.actorId,workspaceId:run.workspaceId}
    const file = await readChatFileForRun(pool, authority, id)
    const url=new URL(request.url)
    if(url.searchParams.get('content')==='bytes') {
      const bytes=new Uint8Array(await chatFileBytes(file))
      await readChatFileForRun(pool,authority,id)
      return new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}}),{
        headers:{...headers,'Content-Type':'application/octet-stream','X-Content-Type-Options':'nosniff'},
      })
    }
    url.search='';url.searchParams.set('content','bytes')
    const transfer=file.size>CHAT_FILE_CHUNK_BYTES?{downloadUrl:url.href}:{data:Buffer.from(await chatFileBytes(file)).toString('base64')}
    await readChatFileForRun(pool, authority, id)
    return Response.json(
      {
        id: file.id,
        name: file.name,
        mediaType: file.mediaType,
        size: file.size,
        sha256: file.sha256,
        ...transfer,
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
