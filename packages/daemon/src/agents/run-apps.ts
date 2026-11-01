// The apps a person connected in Mikka (Composio toolkits), one MCP entry
// each, for this run only. Every URL is the Mikka server's run-app endpoint,
// never Composio: the server holds the credentials and owns allow/ask/deny.
// The bearer is the run's own token, which stops working when the run ends.
import type { RunAssignment } from '@mikka/protocol'

export interface RunApps {
  token: string
  /** `name` is the MCP server name and the toolkit slug. */
  apps: readonly { name: string; url: string }[]
}

const TOOLKIT = /^[a-z][a-z0-9_]{0,63}$/

/** The entries this run registers, derived only from the claimed assignment. */
export function runApps(mcp: RunAssignment['mcp']): RunApps | undefined {
  if (!mcp?.apps?.length) return undefined
  let base: URL
  try { base = new URL(mcp.url) } catch { return undefined }
  if (!/\/api\/mcp\/?$/.test(base.pathname) || base.username || base.password || base.search || base.hash ||
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) ||
    !/^mkw_[A-Za-z0-9_-]{43}$/.test(mcp.token)) return undefined
  const names = [...new Set(mcp.apps)].filter(name => TOOLKIT.test(name) && !name.startsWith('mikka'))
  if (!names.length) return undefined
  return {
    token: mcp.token,
    apps: names.map(name => ({ name, url: new URL(base.pathname.replace(/\/api\/mcp\/?$/, `/api/runs/mcp/${name}`), base).toString() })),
  }
}

/** The Mikka server host the app entries reach. */
export const runAppsHost = (apps?: RunApps) => apps?.apps[0] ? new URL(apps.apps[0].url).host : undefined
