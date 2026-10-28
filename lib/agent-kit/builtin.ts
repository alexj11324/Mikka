import definition from '../../agents/default/agent.json'
import { parseDefinition } from './definition'
import { COMPUTER_TOOL_IDS } from './registry'

// The empty additive instructions preserve the existing AI SDK and native host prompts.
export const DEFAULT_AGENT_DEFINITION = parseDefinition(definition)

/** For a newly initialized scope only. Existing stored definitions and running
 * snapshots keep their exact tool list until the owner explicitly saves a version.
 */
export function builtinAgentDefinition(options: { computerEnabled?: boolean } = {}) {
  return parseDefinition({
    ...DEFAULT_AGENT_DEFINITION,
    tools: [...DEFAULT_AGENT_DEFINITION.tools, ...(options.computerEnabled ? COMPUTER_TOOL_IDS : [])],
  })
}
