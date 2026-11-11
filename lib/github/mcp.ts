import { runMcpCommand, type McpCommand, type McpDependencies } from '@/lib/plugins/mcp'
import { credentialMasker, maskDeep } from '@/lib/secrets/mask'
import { GitHubAccessError } from './user-access-error'
import { createHash } from 'node:crypto'
import { catalogueToolDisplayName } from '@/lib/coordinator/tool-metadata'

/**
 * The Coordinator's own GitHub tools (decision 2026-11-02-1730): GitHub's
 * official hosted MCP server, called as the person with their own GitHub user
 * token. The token is only an Authorization header here; results are masked
 * and errors are codes, so it never reaches the model, chat, logs or memory.
 */
export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/'
/** The server's default toolsets plus Actions, for CI. */
export const GITHUB_MCP_TOOLSETS = 'default,actions'
export const GITHUB_MCP_MIN_VALIDITY_MS = 5 * 60_000

const PAGE_BYTES = 32 * 1024
const CURSOR_PREFIX = 'mikka-github-tools:'
type Page = { remote: string | null; offset: number }
type ListedTool = Record<string, unknown> & { name: string; description?: string; displayName?: string; annotations?: unknown }
export type GitHubMcpCommand = Extract<McpCommand, { name: string }> | { cursor?: string; tool?: string }
class GitHubCursorError extends Error {}

const cursorScope = (userId: string) => createHash('sha256').update(`${GITHUB_MCP_URL}\0${userId}`).digest('hex')
// Only pagination state, never authority: every page lists again with this caller's own token.
function encodeCursor(userId: string, page: Page): string {
  const encoded = CURSOR_PREFIX + Buffer.from(JSON.stringify([cursorScope(userId), page.remote, page.offset])).toString('base64url')
  if (encoded.length > 4096) throw new GitHubCursorError()
  return encoded
}
function decodeCursor(userId: string, cursor?: string): Page | null {
  if (cursor === undefined) return { remote: null, offset: 0 }
  if (!cursor.startsWith(CURSOR_PREFIX) || cursor.length > 4096) return null
  try {
    const raw = cursor.slice(CURSOR_PREFIX.length)
    const bytes = Buffer.from(raw, 'base64url')
    if (bytes.toString('base64url') !== raw) return null
    const value: unknown = JSON.parse(bytes.toString())
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== cursorScope(userId) ||
      !(value[1] === null || (typeof value[1] === 'string' && value[1].length <= 2048)) ||
      !Number.isSafeInteger(value[2]) || value[2] < 0) return null
    return { remote: value[1], offset: value[2] }
  } catch { return null }
}

function cataloguePage(userId: string, result: Record<string, unknown>, page: Page, name?: string) {
  if ('error' in result) return result
  if (!Array.isArray(result.tools) || result.tools.some(tool => !tool || typeof tool !== 'object' ||
    typeof tool.name !== 'string' || tool.name.length < 1 || tool.name.length > 128 ||
    (tool.description !== undefined && typeof tool.description !== 'string')) ||
    !(result.nextCursor === null || typeof result.nextCursor === 'string') ||
    (typeof result.nextCursor === 'string' && result.nextCursor.length > 2048) || page.offset > result.tools.length) return { error: 'githubToolCatalogueInvalid' }
  const tools = result.tools as ListedTool[]
  const next = (offset: number) => offset < tools.length
    ? encodeCursor(userId, { remote: page.remote, offset })
    : result.nextCursor ? encodeCursor(userId, { remote: result.nextCursor as string, offset: 0 }) : null
  if (name !== undefined) {
    const found = tools.find(tool => tool.name === name)
    const response = { tools: found ? [found] : [], nextCursor: found ? null : next(tools.length) }
    // A schema is either complete or refused; truncated properties are unsafe to call.
    return Buffer.byteLength(JSON.stringify(response)) <= PAGE_BYTES ? response : { error: 'githubToolSchemaTooLarge' }
  }
  const selected: { name: string; description?: string; displayName: string; readOnly?: boolean }[] = []
  for (let index = page.offset; index < tools.length; index++) {
    const tool = tools[index]
    const annotations = tool.annotations
    const readOnly = annotations !== null && typeof annotations === 'object' && !Array.isArray(annotations) &&
      (annotations as Record<string, unknown>).readOnlyHint === true
    const summary = { name: tool.name, displayName: tool.displayName ?? catalogueToolDisplayName(tool), ...(readOnly ? { readOnly: true } : {}), ...(tool.description === undefined ? {} : { description: tool.description.slice(0, 240) }) }
    if (Buffer.byteLength(JSON.stringify({ tools: [...selected, summary], nextCursor: next(index + 1) })) > PAGE_BYTES) break
    selected.push(summary)
  }
  if (!selected.length && page.offset < tools.length) return { error: 'githubToolCatalogueInvalid' }
  return { tools: selected, nextCursor: next(page.offset + selected.length) }
}

/** `token` is asked only for `userId`, the caller; it throws GitHubAccessError when there is no usable credential. */
export function createGitHubMcpRuntime(token: (userId: string) => Promise<{ token: string }>, dependencies: McpDependencies = {}) {
  return async (userId: string, command: GitHubMcpCommand) => {
    const page = 'name' in command ? null : decodeCursor(userId, command.cursor)
    if (!('name' in command) && !page) return { error: 'githubToolCursorInvalid' }
    const name = 'tool' in command ? command.tool : undefined
    if (name !== undefined && (typeof name !== 'string' || name.length < 1 || name.length > 128)) return { error: 'githubToolNameInvalid' }
    const result = await runMcpCommand(async () => {
      const { token: value } = await token(userId)
      return { url: GITHUB_MCP_URL, transport: 'http', headers: { Authorization: `Bearer ${value}`, 'X-MCP-Toolsets': GITHUB_MCP_TOOLSETS }, secrets: [value] }
    }, 'name' in command ? command : page?.remote ? { cursor: page.remote } : {}, dependencies, { code: error => error instanceof GitHubAccessError ? error.code : undefined })
    // Any other credential-shaped text GitHub returns is masked too.
    const masked = maskDeep(result, credentialMasker)
    if (!page) return masked
    try { return cataloguePage(userId, masked, page, name) }
    catch (error) {
      if (error instanceof GitHubCursorError) return { error: 'githubToolCursorInvalid' }
      throw error
    }
  }
}
