import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

/** The catalog and submission function come from the host, never model input.
 * A catalog entry describes a capability, not an authorization grant. The host
 * must bind the call to a real run and check current authority before any effect. */
export interface ModelWriteTool {
  name: string
  description: string
  inputSchema: z.ZodType<Record<string, unknown>>
}
export interface ModelWriteCall {
  action: string
  input: Record<string, unknown>
  toolCallId: string
}

export function modelWriteTools(enabled: boolean, catalog: readonly ModelWriteTool[], submit: (call: ModelWriteCall) => Promise<unknown>): ToolSet {
  if (!enabled) return {}
  const tools: ToolSet = Object.create(null)
  for (const entry of catalog) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(entry.name) || Object.hasOwn(tools, entry.name)) throw new Error('invalidWriteToolCatalog')
    const { name, description, inputSchema } = entry
    tools[name] = tool({
      description,
      inputSchema,
      execute: async (raw, options) => {
        // Validate here as well as at the SDK boundary; native relays and tests
        // can call execute directly. The host must derive run/owner/policy itself.
        const input = inputSchema.parse(raw)
        if (!options.toolCallId) throw new Error('writeToolCallIdRequired')
        return submit({ action: name, input, toolCallId: options.toolCallId })
      },
    })
  }
  return tools
}
