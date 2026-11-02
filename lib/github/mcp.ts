import { runMcpCommand, type McpCommand, type McpDependencies } from '@/lib/plugins/mcp'
import { credentialMasker, maskDeep } from '@/lib/secrets/mask'
import { GitHubAccessError } from './user-access-error'

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

/** `token` is asked only for `userId`, the caller; it throws GitHubAccessError when there is no usable credential. */
export function createGitHubMcpRuntime(token: (userId: string) => Promise<{ token: string }>, dependencies: McpDependencies = {}) {
  return async (userId: string, command: McpCommand) => {
    const result = await runMcpCommand(async () => {
      const { token: value } = await token(userId)
      return { url: GITHUB_MCP_URL, transport: 'http', headers: { Authorization: `Bearer ${value}`, 'X-MCP-Toolsets': GITHUB_MCP_TOOLSETS }, secrets: [value] }
    }, command, dependencies, { code: error => error instanceof GitHubAccessError ? error.code : undefined })
    // Any other credential-shaped text GitHub returns is masked too.
    return maskDeep(result, credentialMasker)
  }
}
