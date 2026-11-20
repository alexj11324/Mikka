import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mcpDeviceCheckReceiptSchema, scrubMcpCheckTools, type McpDeviceCheckCommand, type McpDeviceCheckReceipt } from '@mikka/protocol/mcp-check'

/** One owner-requested check. The SDK starts the exact argv without a shell,
 * inherits only its documented safe environment, and closes the child. This
 * never executes tools or sends a model request. */
export async function checkStdioMcp(command: McpDeviceCheckCommand, parentSignal?: AbortSignal): Promise<McpDeviceCheckReceipt> {
  const remaining = Date.parse(command.expiresAt) - Date.now()
  const failed = (failureReason: Extract<McpDeviceCheckReceipt, { status: 'check_failed' }>['failureReason']): McpDeviceCheckReceipt => ({ id: command.id, status: 'check_failed', failureReason })
  if (remaining <= 0 || parentSignal?.aborted) return failed('checkExpired')
  const deadline = AbortSignal.timeout(Math.min(25_000, remaining))
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline
  const server = command.server
  const transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: server.cwd, env: server.env, stderr: 'ignore' })
  const client = new Client({ name: 'Mikka connection check', version: '1' }, { capabilities: {} })
  client.onerror = () => {}
  const closeOnAbort = () => { void transport.close() }
  signal.addEventListener('abort', closeOnAbort, { once: true })
  try {
    await client.connect(transport, { signal, timeout: Math.min(25_000, remaining) })
    const tools: { name: string; description?: string }[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : {}, { signal })
      tools.push(...result.tools)
      if (tools.length > 1000) return failed('catalogueIncomplete')
      if (!result.nextCursor) return mcpDeviceCheckReceiptSchema.parse({ id: command.id, status: 'connected', tools: scrubMcpCheckTools(tools, server) })
      if (cursors.has(result.nextCursor)) return failed('catalogueIncomplete')
      cursors.add(result.nextCursor); cursor = result.nextCursor
    }
    return failed('catalogueIncomplete')
  } catch { return failed(signal.aborted ? 'checkExpired' : transport.pid === null ? 'processFailed' : 'protocolFailed') }
  finally {
    signal.removeEventListener('abort', closeOnAbort)
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  }
}
