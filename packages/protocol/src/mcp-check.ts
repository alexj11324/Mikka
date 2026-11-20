import { z } from 'zod'
import { taskMcpServerSchema, type TaskMcpServer } from './task-mcp'

export const MCP_CHECK_HEADER = 'x-mikka-mcp-check'
export const mcpCheckedToolSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/), description: z.string().max(4000).default(''),
}).strict()
/** Owner-requested discovery only; configuration stays in device memory. */
export const mcpDeviceCheckCommandSchema = z.object({
  id: z.uuid(), expiresAt: z.iso.datetime({ offset: true }), server: taskMcpServerSchema.options[1],
}).strict()
export type McpDeviceCheckCommand = z.infer<typeof mcpDeviceCheckCommandSchema>
export const mcpDeviceCheckReceiptSchema = z.discriminatedUnion('status', [
  z.object({ id: z.uuid(), status: z.literal('connected'), tools: z.array(mcpCheckedToolSchema).max(1000) }).strict(),
  z.object({ id: z.uuid(), status: z.literal('check_failed'), failureReason: z.enum(['processFailed', 'protocolFailed', 'checkExpired', 'catalogueIncomplete']) }).strict(),
]).refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 512_000)
export type McpDeviceCheckReceipt = z.infer<typeof mcpDeviceCheckReceiptSchema>

/** A server may echo its environment credential in a description. Strip it at
 * both the device boundary and the owning storage boundary before sharing. */
export function scrubMcpCheckTools(tools: { name: string; description?: string }[], server: Extract<TaskMcpServer, { transport: 'stdio' }>) {
  const needles = Object.values(server.env).filter(Boolean).flatMap(value => [value, encodeURIComponent(value), btoa(Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join(''))]).sort((a, b) => b.length - a.length)
  const scrub = (value: string) => needles.reduce((result, secret) => result.split(secret).join('[redacted]'), value)
  return tools.map(tool => mcpCheckedToolSchema.parse({ name: scrub(tool.name), description: scrub(tool.description ?? '').slice(0, 4000) }))
}
