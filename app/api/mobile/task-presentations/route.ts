import { getTaskPresentations } from '@/app/actions/task-domain'
import { actAs } from '@/lib/acting-user'
import { ActionFailureError } from '@/lib/action-error'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { taskPresentationsInput } from '@/lib/task-presentation-input'
import { WorkspaceError } from '@/lib/workspace-error'

export const dynamic = 'force-dynamic'

/** Native Cookie transport for the existing bounded Task presentation reader. */
async function handlePOST(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()

  const reader = request.body?.getReader()
  if (!reader) return json({ error: 'invalidRequest' }, 400)
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 16_384) return json({ error: 'bodyTooLarge' }, 413)
      chunks.push(chunk.value)
    }
  } finally {
    try { await reader.cancel() }
    catch { /* Stream cleanup must preserve the response or original read error. */ }
    finally { reader.releaseLock() }
  }
  let input: unknown
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { return json({ error: 'invalidRequest' }, 400) }
  const parsed = taskPresentationsInput.safeParse(input)
  if (!parsed.success) return json({ error: 'invalidRequest' }, 400)

  try {
    // Pass the original reader so non-enumerable principal/PAT symbols survive.
    return json(await actAs(user, () => getTaskPresentations(parsed.data)))
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'authRequired') return unauthorized()
    if (error instanceof WorkspaceError || (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied'))
      return json({ error: 'workspaceAccessDenied' }, 403)
    throw error
  }
}

export const POST = withRequestLog('/api/mobile/task-presentations', handlePOST)
