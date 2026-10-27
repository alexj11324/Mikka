export type SavedAgentSession = { id: string; title: string; updatedAt: string; preview?: string }

/**
 * One line of plain text for the conversation list: the first sentence-sized
 * string in the reply (OpenUI Lang keeps prose in quoted arguments), else
 * plain-text replies as they are, else the person's last message.
 */
export function sessionPreview(completion: string | null | undefined, prompt: string | null | undefined): string {
  const reply = completion?.trim() ?? ''
  for (const match of reply.matchAll(/"((?:[^"\\\n]|\\.){4,})"/g)) {
    try {
      const text = (JSON.parse(`"${match[1]}"`) as string).replace(/\s+/g, ' ').trim()
      if (/[\p{L}\p{N}]/u.test(text) && !/^[\w-]+$/.test(text)) return text.slice(0, 120)
    } catch { /* not a JSON string literal */ }
  }
  if (reply && !/^\w+\s*=/.test(reply)) return reply.replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return (prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

export type SavedAgentTurn = { id: string; prompt: string; completion: string; status: 'pending' | 'complete' | 'failed' | 'stopped'; error: string | null }
export type AgentHistory = { sessions: SavedAgentSession[]; sessionId: string | null; turns: SavedAgentTurn[] }
