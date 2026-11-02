import definition from '../../agents/default/agent.json'
import { parseDefinition } from './definition'
import { COMPUTER_TOOL_IDS, PLATFORM_TOOL_ADDED, type AgentToolId } from './registry'

// The empty additive instructions preserve the existing AI SDK and native host prompts.
export const DEFAULT_AGENT_DEFINITION = parseDefinition(definition)

/** For a newly initialized scope. Stored definitions are never rewritten; a new
 * execution's tools come from platformEffectiveTools.
 */
export function builtinAgentDefinition(options: { computerEnabled?: boolean } = {}) {
  return parseDefinition({
    ...DEFAULT_AGENT_DEFINITION,
    tools: [...DEFAULT_AGENT_DEFINITION.tools, ...(options.computerEnabled ? COMPUTER_TOOL_IDS : [])],
  })
}

export interface StoredToolSource {
  /** Source of the version that chose the tools (an improvement keeps its base's tools). */
  source: 'builtin' | 'user' | 'improvement'
  createdAt: Date | string | null | undefined
  tools: readonly AgentToolId[]
}

/** Tools a new execution starts with. A stored builtin copy follows the current
 * built-in list (keeping computer tools it already had). An owner-chosen version
 * keeps its own list plus the built-in tools that joined the platform after it was
 * created; a built-in tool that existed then and is missing was removed on purpose.
 * Later host filters (scheduled reads, rollout gates, native scope) still apply. */
export function platformEffectiveTools(stored: StoredToolSource, builtinTools: readonly AgentToolId[]): AgentToolId[] {
  if (stored.source === 'builtin') {
    return [...new Set([...builtinTools, ...stored.tools.filter(id => (COMPUTER_TOOL_IDS as readonly string[]).includes(id))])]
  }
  const created = stored.createdAt ? new Date(stored.createdAt).getTime() : Number.NaN
  if (Number.isNaN(created)) return [...stored.tools]
  const added = builtinTools.filter(id => {
    const at = PLATFORM_TOOL_ADDED[id]
    return !stored.tools.includes(id) && at !== undefined && Date.parse(at) > created
  })
  return [...new Set([...stored.tools, ...added])]
}
