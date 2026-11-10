import 'server-only'
import { isReadOnlyTool, type AppTool } from '@/lib/app-tools'
import { GITHUB_MCP_MIN_VALIDITY_MS, createGitHubMcpRuntime } from '@/lib/github/mcp'
import { githubTokenForUser } from '@/lib/github/user-access'
import { getComposio } from '@/lib/composio'
import { OWN_INTEGRATIONS } from '@/lib/composio-accounts'

/** The real catalogue an app offers, as names and read/write marks. */
export type AppToolSummary = { name: string; displayName: string; readOnly: boolean }
export type AppToolCatalogue = {
  app: string
  count: number
  readOnlyCount: number
  tools: AppToolSummary[]
  truncated: boolean
  error?: string
}

const MAX_TOOLS = 200
const GITHUB_PAGES = 12

/** One hosted-MCP page, as the runtime lists it; the shape is untrusted provider output. */
export type GitHubToolPage = { error?: unknown; tools?: unknown; nextCursor?: string | null }

/** Dependencies are injectable so pagination and provider errors are testable without a live provider. */
export type AppToolCatalogueDeps = {
  /** The caller's own GitHub page loader; the default verifies the person's token on every page. */
  githubPage?: (userId: string, cursor?: string) => Promise<GitHubToolPage>
  composio?: (app: string) => Promise<AppTool[]>
}

function githubPages(): (userId: string, cursor?: string) => Promise<GitHubToolPage> {
  const runtime = createGitHubMcpRuntime(owner => githubTokenForUser(owner, { minValidityMs: GITHUB_MCP_MIN_VALIDITY_MS }))
  return (userId, cursor) => runtime(userId, cursor ? { cursor } : {})
}

async function githubCatalogue(userId: string, listPage: (userId: string, cursor?: string) => Promise<GitHubToolPage>): Promise<{ tools: AppToolSummary[]; truncated: boolean; error?: string }> {
  const tools: AppToolSummary[] = []
  let cursor: string | undefined
  let truncated = false
  for (let page = 0; page < GITHUB_PAGES; page++) {
    const result = await listPage(userId, cursor)
    if (result.error !== undefined) return { tools, truncated: true, error: String(result.error) }
    if (!Array.isArray(result.tools)) return { tools, truncated: true, error: 'githubToolCatalogueInvalid' }
    for (const entry of result.tools) {
      if (!entry || typeof entry !== 'object') continue
      const tool = entry as { name?: unknown; displayName?: unknown; readOnly?: unknown }
      if (typeof tool.name !== 'string' || tool.name.length === 0) continue
      if (tools.length >= MAX_TOOLS) { truncated = true; break }
      tools.push({ name: tool.name, displayName: typeof tool.displayName === 'string' ? tool.displayName : tool.name, readOnly: tool.readOnly === true })
    }
    cursor = typeof result.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined
    if (!cursor || tools.length >= MAX_TOOLS) break
    if (page === GITHUB_PAGES - 1) truncated = true
  }
  return { tools, truncated }
}

function composioCatalogue(app: string, tools: AppTool[]): { tools: AppToolSummary[]; truncated: boolean } {
  const selected = tools
    .filter(tool => tool.toolkit?.slug === app && tool.slug.startsWith(`${app.toUpperCase()}_`))
    .slice(0, MAX_TOOLS)
  return {
    tools: selected.map(tool => ({ name: tool.slug, displayName: tool.name, readOnly: isReadOnlyTool(tool) })),
    truncated: tools.length >= MAX_TOOLS,
  }
}

/** One connected app's real tools. GitHub is its hosted MCP catalogue; other store apps are Composio's. */
export async function readAppToolCatalogue(
  userId: string,
  app: string,
  deps: AppToolCatalogueDeps = {},
): Promise<AppToolCatalogue> {
  if (app === 'github') {
    const catalogued = await githubCatalogue(userId, deps.githubPage ?? githubPages())
    return {
      app, tools: catalogued.tools, count: catalogued.tools.length,
      readOnlyCount: catalogued.tools.filter(tool => tool.readOnly).length,
      truncated: catalogued.truncated,
      ...(catalogued.error ? { error: catalogued.error } : {}),
    }
  }
  if (OWN_INTEGRATIONS.has(app)) {
    return { app, count: 0, readOnlyCount: 0, tools: [], truncated: false }
  }
  const client = getComposio()
  const listed = deps.composio
    ? await deps.composio(app)
    : client
      ? await (client.tools.getRawComposioTools({ toolkits: [app], limit: MAX_TOOLS }) as Promise<AppTool[]>)
      : []
  const catalogued = composioCatalogue(app, listed)
  return {
    app, tools: catalogued.tools, count: catalogued.tools.length,
    readOnlyCount: catalogued.tools.filter(tool => tool.readOnly).length,
    truncated: catalogued.truncated,
  }
}
