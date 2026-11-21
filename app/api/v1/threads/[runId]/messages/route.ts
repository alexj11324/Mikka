import { interopApi, interopBody, sendKey } from '@/lib/interop/http'
import { readThreadMessages, sendToThread } from '@/lib/interop/threads'

type Context = { params: Promise<{ runId: string }> }

/** A thread's attempts, messages and agent text, masked (decision 2026-11-19-2200). */
export const GET = async (request: Request, { params }: Context) => {
  const { runId } = await params
  return interopApi(request, 'threads:read', principal => readThreadMessages(principal, runId))
}

/** Send to a thread and wake it; an ended thread continues in the same thread. */
export const POST = async (request: Request, { params }: Context) => {
  const { runId } = await params
  return interopApi(request, 'threads:write', async principal => {
    const body = await interopBody(request)
    return sendToThread(principal, { runId, text: body.text as string, key: sendKey(request, body) as string, delivery: body.delivery as 'queue' | 'steer' | undefined })
  }, 202)
}
