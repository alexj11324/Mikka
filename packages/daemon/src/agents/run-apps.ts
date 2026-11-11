// The apps a person connected in Mikka (Composio toolkits), one MCP entry
// each, for this run only. Every URL is the Mikka server's run-app endpoint,
// never Composio: the server holds the credentials and owns allow/ask/deny.
// The bearer is the run's own token, which stops working when the run ends.
import { taskMcpServerSchema, type TaskMcpServer, type RunAssignment } from '@mikka/protocol'
import { resolve } from 'node:path'
import { runTraceHeaders, type RunTraceContext } from '@mikka/protocol/trace-context'
import { trustedServerEndpoint } from '../trusted-endpoint'

export interface RunApps {
  token: string
  /** `name` is the MCP server name and the toolkit slug. */
  apps: readonly { name: string; url: string }[]
  servers?: readonly TaskMcpServer[]
}

/** The host-issued task MCP authority is independent of connected apps. */
export interface RunMcp { url: string; token: string; decisionCatalogue?: NonNullable<RunAssignment['mcp']>['decisionCatalogue']; traceparent?: string }
export function runMcp(mcp: RunAssignment['mcp'], traceContext?: RunTraceContext): RunMcp | undefined {
  if (!mcp) return undefined
  let url: URL
  try { url = new URL(mcp.url) } catch { return undefined }
  if (!/\/api\/mcp\/?$/.test(url.pathname) || !trustedServerEndpoint(url) || !/^mkw_[A-Za-z0-9_-]{43}$/.test(mcp.token)) return undefined
  const traceparent = runTraceHeaders(traceContext).traceparent
  return { url: url.toString(), token: mcp.token, ...(mcp.decisionCatalogue ? { decisionCatalogue: mcp.decisionCatalogue } : {}),
    ...(traceparent ? { traceparent } : {}) }
}

const TOOLKIT = /^[a-z][a-z0-9_]{0,63}$/

/** The entries this run registers, derived only from the claimed assignment. */
export function runApps(mcp: RunAssignment['mcp']): RunApps | undefined {
  if (!mcp?.apps?.length && !mcp?.servers?.length) return undefined
  let base: URL
  try { base = new URL(mcp.url) } catch { return undefined }
  if (!/\/api\/mcp\/?$/.test(base.pathname) || !trustedServerEndpoint(base) ||
    !/^mkw_[A-Za-z0-9_-]{43}$/.test(mcp.token)) return undefined
  const names = [...new Set(mcp.apps ?? [])].filter(name => TOOLKIT.test(name) && !name.startsWith('mikka'))
  const servers = mcp.servers?.map(server => taskMcpServerSchema.parse(server))
  if (servers && new Set(servers.map(server => server.name)).size !== servers.length) throw new Error('Invalid duplicate MCP server names')
  if (!names.length && !servers?.length) return undefined
  return {
    token: mcp.token,
    apps: names.map(name => ({ name, url: new URL(base.pathname.replace(/\/api\/mcp\/?$/, `/api/runs/mcp/${name}`), base).toString() })),
    ...(servers?.length ? { servers } : {}),
  }
}

/** The Mikka server host the app entries reach. */
export const runAppsHost = (apps?: RunApps) => apps?.apps[0] ? new URL(apps.apps[0].url).host : undefined

/** The CLI APIs lack a portable per-STDIO cwd field. This launcher only changes cwd and execs argv. */
export function nativeMcpProcess(server: Extract<TaskMcpServer, { transport: 'stdio' }>) {
  return server.cwd ? { command: process.execPath, args: [resolve(import.meta.dirname, 'mcp-stdio-launcher.mjs'), server.cwd, server.command, ...server.args], env: server.env }
    : { command: server.command, args: server.args, env: server.env }
}
