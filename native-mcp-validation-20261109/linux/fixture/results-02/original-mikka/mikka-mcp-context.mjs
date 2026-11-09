// A late-bound stdio entry for an already initialized official Codex process.
// Only an owner-private file contains the actual run environment. The native
// thread config persists its non-secret path, never the run token.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ENTRY = fileURLToPath(new URL('./mikka-mcp.mjs', import.meta.url))
const KEYS = new Set(['MIKKA_DECISION_MCP_URL', 'MIKKA_DECISION_MCP_TOKEN', 'MIKKA_DECISION_MCP_TRACEPARENT', 'MIKKA_DECISION_MCP_CATALOGUE', 'MIKKA_MCP_HTTP_OBSERVATION_URL', 'ELECTRON_RUN_AS_NODE'])
export function readMcpContext(path, runId, nonce) {
  if (!/^[a-f0-9-]{36}$/.test(runId ?? '') || !/^[a-f0-9-]{36}$/.test(nonce ?? '') || resolve(path) !== path) throw Error('mcp_context_invalid')
  const parent = lstatSync(dirname(path))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) throw Error('mcp_context_unsafe')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let raw
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > 65536) throw Error('mcp_context_unsafe')
    const buffer = Buffer.alloc(65537), count = readSync(fd, buffer, 0, buffer.length, 0)
    if (count !== s.size || count > 65536) throw Error('mcp_context_invalid')
    raw = JSON.parse(buffer.subarray(0, count).toString('utf8'))
  } finally { closeSync(fd) }
  if (!raw || Object.keys(raw).sort().join(',') !== 'args,env,nonce,runId,version' || raw.version !== 1 || raw.runId !== runId || raw.nonce !== nonce ||
    !Array.isArray(raw.args) || raw.args[0] !== ENTRY || raw.args.length > 64 ||
    raw.args.some(value => typeof value !== 'string' || value.includes('\0') || value.length > 32768) ||
    !raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env) ||
    Object.entries(raw.env).some(([key, value]) => !KEYS.has(key) || typeof value !== 'string' || value.includes('\0') || value.length > 32768)) throw Error('mcp_context_invalid')
  return { args: raw.args, env: raw.env }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 5) throw Error('mcp_context_invalid')
    const context = readMcpContext(process.argv[2], process.argv[3], process.argv[4])
    process.argv = [process.execPath, ...context.args]
    Object.assign(process.env, context.env)
    await import('./mikka-mcp.mjs')
  } catch {
    process.stderr.write('mikka-mcp: run context unavailable\n')
    process.exitCode = 2
  }
}
