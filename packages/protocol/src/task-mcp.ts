import { z } from 'zod'

const atom = z.string().min(1).max(4096).refine(value => !/[\r\n\0]/.test(value))
export const mcpEnvironmentSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(16_384).refine(value => !value.includes('\0')))
export const mcpHeadersSchema = z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine(name => !/^(?:host|cookie|set-cookie|connection|content-length|transfer-encoding|proxy-.*|x-forwarded-.*)$/i.test(name)), atom)
const common = { name: z.string().regex(/^mcp_[a-z0-9_]{1,64}$/) }
/** Host-selected configuration delivered only to the task machine, never to a reusable image. */
export const taskMcpServerSchema = z.discriminatedUnion('transport', [
  z.object({ ...common, transport: z.enum(['http', 'sse']), url: z.url().refine(value => { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.hash }), headers: mcpHeadersSchema.default({}) }).strict(),
  z.object({ ...common, transport: z.literal('stdio'), command: atom, args: z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(128).default([]), cwd: atom.optional(), env: mcpEnvironmentSchema.default({}) }).strict(),
])
export type TaskMcpServer = z.infer<typeof taskMcpServerSchema>

/** Values are allowed in the selected task, while logs and journals remain credential-free. */
export function taskMcpSecretValues(servers: readonly TaskMcpServer[] = []): string[] {
  return servers.flatMap(server => Object.values(server.transport === 'stdio' ? server.env : server.headers)).filter(Boolean)
}
