import definition from '../../agents/default/agent.json'
import { parseDefinition } from './definition'

// The empty additive instructions preserve the existing AI SDK and native host prompts.
export const DEFAULT_AGENT_DEFINITION = parseDefinition(definition)
