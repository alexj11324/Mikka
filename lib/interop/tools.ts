import 'server-only'
import type { z } from 'zod'
import { InteropError } from './errors'
import { INTEROP_TOOLS, type InteropToolId } from './tool-schemas'
import { principalSender, type InteropPrincipal } from './principal'
import { listInteropArtifacts, readInteropArtifact } from './artifacts'
import { listInteropBots, readBotChat, sendToBot } from './bots'
import { listThreads, readRunDiff, readThreadMessages, sendToThread } from './threads'
import { InteropDriveConflict, listInteropDrive, readInteropDriveFile, writeInteropDriveFile } from './drive'

export type InteropToolResult = Record<string, unknown> | unknown[] | { error: string; detail?: string }

/** How an interop refusal reads to a model: its registered code and detail only. */
export function interopFailure(error: unknown): { error: string; detail?: string; headDigest?: string; headVersionId?: string; paths?: string[] } {
  if (error instanceof InteropDriveConflict) return { error: error.code, headDigest: error.headDigest, headVersionId: error.headVersionId, paths: error.paths }
  if (error instanceof InteropError) return error.detail ? { error: error.code, detail: error.detail } : { error: error.code }
  throw error
}

/** Who a Drive version says wrote it; ids only, never a person's name taken from input. */
export function interopAuthor(principal: InteropPrincipal): string {
  const sender = principalSender(principal)
  return `${sender.kind}:${sender.id}`
}

/**
 * Run one interop tool for a principal. The input is parsed again here, so a
 * caller that skipped its own schema cannot widen anything.
 */
export async function runInteropTool(principal: InteropPrincipal, name: InteropToolId, raw: unknown, signal?: AbortSignal): Promise<InteropToolResult> {
  const input = <N extends InteropToolId>(tool: N): z.infer<typeof INTEROP_TOOLS[N]['inputSchema']> => {
    const parsed = INTEROP_TOOLS[tool].inputSchema.safeParse(raw)
    if (!parsed.success) throw new InteropError('interop_invalid_request', { cause: parsed.error })
    return parsed.data as z.infer<typeof INTEROP_TOOLS[N]['inputSchema']>
  }
  try {
    switch (name) {
      case 'list_threads': return { threads: await listThreads(principal, input(name)) }
      case 'read_thread_messages': return await readThreadMessages(principal, input(name).runId)
      case 'read_run_diff': return await readRunDiff(principal, input(name).runId)
      case 'list_artifacts': return { artifacts: await listInteropArtifacts(principal, input(name)) }
      case 'read_artifact': { const { artifactId, version } = input(name); return { ...await readInteropArtifact(principal, artifactId, version) } }
      case 'list_bots': input(name); return { bots: await listInteropBots(principal) }
      case 'read_bot_chat': { const { botId, limit } = input(name); return await readBotChat(principal, botId, limit) }
      case 'send_to_thread': return await sendToThread(principal, input(name))
      case 'send_to_bot': return await sendToBot(principal, input(name))
      case 'drive_list': return { ...await listInteropDrive(principal, input(name)) }
      case 'drive_read': return { ...await readInteropDriveFile(principal, input(name), signal) }
      case 'drive_write': return { ...await writeInteropDriveFile(principal, input(name), interopAuthor(principal)) }
    }
  } catch (error) {
    return interopFailure(error)
  }
}
