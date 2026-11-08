import { randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, linkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MCP_SERVER_SCRIPT, type McpServerSpec } from './agents/run-context'

/** The file survives legal native MCP child restarts. It is removed only
 * after this task's native process group has drained. */
export function writeCodexMcpContext(privateDir: string, runId: string, spec: McpServerSpec) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw Error('Invalid MCP run identity')
  if (spec.args[0] !== MCP_SERVER_SCRIPT) throw Error('Invalid MCP context entry')
  const directory = join(privateDir, 'mcp-contexts')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw Error('Unsafe MCP context directory')
  const nonce = randomUUID(), path = join(directory, runId + '.json'), temporary = join(directory, nonce + '.next')
  const bytes = JSON.stringify({ version: 1, runId, nonce, args: spec.args, env: spec.env })
  if (Buffer.byteLength(bytes) > 65536) throw Error('MCP context exceeds bound')
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    linkSync(temporary, path)
  } finally { unlinkSync(temporary) }
  let removed = false
  return {
    server: { command: spec.command, args: [join(dirname(MCP_SERVER_SCRIPT), 'mikka-mcp-context.mjs'), path, runId, nonce], env: {} },
    close() { if (!removed) { removed = true; try { unlinkSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } } },
  }
}
