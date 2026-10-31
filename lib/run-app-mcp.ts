import { isToolkitSlug } from '@/lib/composio-accounts'
import { isReadOnlyTool, type AppTool } from '@/lib/app-tools'

// A device run reaches a person's connected app through one Mikka MCP entry
// per toolkit (/api/runs/mcp/<toolkit>). The run token is the only authority:
// owner, Bot and run come from it, never from the request, and it stops
// working when the run ends. The toolkit must be one this owner connected and
// this Bot may use, the same list the claim gave the daemon.

export type RunAppAuth = { token?: string; expiresAt?: number; extra?: Record<string, unknown> } | undefined
export type RunAppScope = { userId: string; botId: string | null; runId: string; toolkit: string }

/** Up to this many of a toolkit's tools are listed on its entry. */
export const MAX_RUN_APP_TOOLS = 100
const MAX_SCHEMA_CHARS = 60_000

export async function authorizeRunApp(auth: RunAppAuth, toolkit: string, allowedToolkits: (userId: string, botId: string | null) => Promise<readonly string[]>, now = Date.now()): Promise<RunAppScope | null> {
  const extra = auth?.extra
  if (!auth?.token?.startsWith('mkw_') || typeof extra?.userId !== 'string' || typeof extra.runId !== 'string') return null
  if (typeof auth.expiresAt !== 'number' || auth.expiresAt * 1000 <= now) return null
  if (!isToolkitSlug(toolkit)) return null
  const botId = typeof extra.botId === 'string' ? extra.botId : null
  if (!(await allowedToolkits(extra.userId, botId)).includes(toolkit)) return null
  return { userId: extra.userId, botId, runId: extra.runId, toolkit }
}

/** A Composio tool as an MCP tool on its toolkit's entry; null when it does not belong there or is too large. */
export function runAppTool(tool: AppTool, toolkit: string) {
  if (tool.toolkit?.slug !== toolkit || !tool.slug.startsWith(`${toolkit.toUpperCase()}_`)) return null
  const input = tool.inputParameters ?? { type: 'object', properties: {} }
  if (JSON.stringify(input).length > MAX_SCHEMA_CHARS || (input as { type?: unknown }).type !== 'object') return null
  return { name: tool.slug, description: (tool.description ?? tool.name).replace(/\s+/g, ' ').slice(0, 1000), inputSchema: input as Record<string, unknown>, readOnly: isReadOnlyTool(tool) }
}
