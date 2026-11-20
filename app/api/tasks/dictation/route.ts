import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { writeAllowed } from '@/lib/mobile-api'
import { ChatFileError } from '@/lib/chat-attachments/extract'
import { loadWorkspaceContext, WorkspaceError } from '@/lib/workspace-access'

export const maxDuration = 120
/** A spoken task description: a few minutes of compressed audio. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const headers = { 'Cache-Control': 'private, no-store' }
const failure = (error: string, status: number) => Response.json({ error }, { status, headers })

/**
 * 新建任务's 语音 (Capy's dictation): the recorded audio becomes text for the description. It reuses chat transcription
 * (lib/chat-attachments/transcribe.ts), so it runs only on the person's own authorized OpenAI key and stores nothing.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return failure('authRequired', 401)
  if (!writeAllowed(request)) return failure('originNotAllowed', 403)
  if (!request.headers.get('content-type')?.startsWith('audio/')) return failure('invalid', 400)
  const reader = request.body?.getReader()
  if (!reader) return failure('invalid', 400)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_AUDIO_BYTES) { await reader.cancel(); return failure('tooLarge', 413) }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  if (!size) return failure('invalid', 400)
  const audio = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength }
  try {
    const { workspace } = await loadWorkspaceContext(session.tokenWorkspaceId, session.user)
    // A workspace-scoped token transcribes only in its own workspace, as every other workspace route checks.
    if (!apiWorkspaceAllowed(session, workspace.id)) return failure('notFound', 404)
    const { transcribeChatAudio } = await import('@/lib/chat-attachments/transcribe')
    return Response.json({ text: await transcribeChatAudio(session.user.id, workspace.id, audio) }, { headers })
  } catch (error) {
    if (error instanceof WorkspaceError) return failure('notFound', 404)
    if (error instanceof ChatFileError) return failure(error.code, error.code === 'audioKeyRequired' ? 409 : 422)
    throw new Error('taskDictationFailed', { cause: error })
  }
}
