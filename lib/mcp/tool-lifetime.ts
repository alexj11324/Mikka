import type { McpServer, ServerContext, StandardSchemaWithJSON, ToolCallback } from '@modelcontextprotocol/server'

type ToolConfig = Parameters<McpServer['registerTool']>[1]

/** Retain only work that the SDK has already started. The original result or
 * rejection still belongs to the SDK; after() only joins its settlement. */
function retained<Args extends [unknown, ServerContext], Result>(callback: (...args: Args) => Result,
  retain: (work: Promise<void>) => void): (...args: Args) => Result {
  return (...args) => {
    // The SDK can finish async input validation after the HTTP exchange has
    // closed. Never begin a new side effect or attach after work at that point.
    args[1].mcpReq.signal.throwIfAborted()
    const result = callback(...args)
    retain(Promise.resolve(result).then(() => undefined, () => undefined))
    return result
  }
}

/** Both OAuth and worker catalogues use complete Standard Schema inputs. */
export function requestOwnedMcpTools(server: McpServer, retain: (work: Promise<void>) => void) {
  return {
    registerTool<Input extends StandardSchemaWithJSON>(name: string,
      config: Omit<ToolConfig, 'inputSchema' | 'outputSchema'> & { inputSchema: Input; outputSchema?: StandardSchemaWithJSON }, callback: ToolCallback<Input>) {
      // The SDK's conditional ToolCallback type loses its generic input when
      // passed through a wrapper; retained() preserves both arguments/result.
      const owned = retained(callback, retain) as ToolCallback<Input>
      return server.registerTool<StandardSchemaWithJSON, Input>(name, config, owned)
    },
  }
}
