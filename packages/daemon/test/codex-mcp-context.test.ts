import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { copyFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { writeCodexMcpContext } from '../src/codex-mcp-context'
import { readMcpContext } from '../src/agents/mikka-mcp-context.mjs'
const roots: string[] = [], runId = '00000000-0000-4000-8000-000000000001'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-mcp-')); roots.push(root)
  const spec = { command: process.execPath, args: [fileURLToPath(new URL('../src/agents/mikka-mcp.mjs', import.meta.url)), '--handoff', join(root, 'handoff.json')], env: {} }
  return { root, spec, value: writeCodexMcpContext(root, runId, spec) }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function request(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: 'pipe' }); let out = '', err = ''
  child.stdout.on('data', b => { out += b }); child.stderr.on('data', b => { err += b })
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n')
  const code = await new Promise<number | null>(resolve => child.once('close', resolve))
  return { code, out, err }
}
it('uses the exact stdio catalogue and supports legal child restart until cleanup', async () => {
  const f = fixture(), expected = await request(f.spec.command, f.spec.args)
  expect((await request(f.value.server.command, f.value.server.args)).out).toBe(expected.out)
  expect((await request(f.value.server.command, f.value.server.args)).out).toBe(expected.out)
  f.value.close()
  expect(await request(f.value.server.command, f.value.server.args)).toMatchObject({ code: 2, out: '', err: 'mikka-mcp: run context unavailable\n' })
})
it('keeps a run token out of the native thread server configuration', () => {
  const f = fixture(); f.value.close()
  const token = 'mkw_' + 'a'.repeat(43), bound = writeCodexMcpContext(f.root, runId, { ...f.spec, env: { MIKKA_DECISION_MCP_TOKEN: token } })
  expect(JSON.stringify(bound.server)).not.toContain(token)
  expect(readFileSync(bound.server.args[1], 'utf8')).toContain(token)
  bound.close()
})
it('rejects different run, permissions and symlinks without parsing or echoing payload', () => {
  const f = fixture(), [, path, id, nonce] = f.value.server.args
  expect(() => readMcpContext(path, '00000000-0000-4000-8000-000000000002', nonce)).toThrow()
  chmodSync(path, 0o644); expect(() => readMcpContext(path, id, nonce)).toThrow()
  chmodSync(path, 0o600)
  const link = join(dirname(path), 'link.json'); symlinkSync(path, link)
  expect(() => readMcpContext(link, id, nonce)).toThrow()
})
it('does not overwrite another run context or broaden an existing directory', () => {
  const f = fixture()
  expect(() => writeCodexMcpContext(f.root, runId, f.spec)).toThrow()
  f.value.close(); chmodSync(join(f.root, 'mcp-contexts'), 0o755)
  expect(() => writeCodexMcpContext(f.root, runId, f.spec)).toThrow()
  const alternate = join(f.root, 'elsewhere'); mkdirSync(alternate)
})

it('resolves the late entry beside the real stdio assets after bundling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-context-bundle-')); roots.push(root)
  await build({ entryPoints: [fileURLToPath(new URL('../src/codex-mcp-context.ts', import.meta.url))],
    outfile: join(root, 'context.mjs'), platform: 'node', format: 'esm', bundle: true,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } })
  for (const name of ['mikka-mcp.mjs', 'mikka-mcp-backend.mjs', 'mikka-mcp-context.mjs', 'capture-copy.mjs', 'native-tool-isolation.mjs'])
    copyFileSync(fileURLToPath(new URL('../src/agents/' + name, import.meta.url)), join(root, name))
  const module = await import(pathToFileURL(join(root, 'context.mjs')).href)
  const value = module.writeCodexMcpContext(join(root, 'private'), runId,
    { command: process.execPath, args: [join(root, 'mikka-mcp.mjs'), '--handoff', join(root, 'handoff.json')], env: {} })
  try {
    expect(value.server.args[0]).toBe(join(root, 'mikka-mcp-context.mjs'))
    const result = await request(value.server.command, value.server.args)
    expect(result.code, result.err).toBe(0)
    expect(JSON.parse(result.out).result.tools.map((tool: { name: string }) => tool.name)).toContain('submit')
  } finally { value.close() }
})

it('rejects an unrelated environment key even alongside the supported trace carrier', async () => {
  const f = fixture(); f.value.close()
  const bound = writeCodexMcpContext(f.root, runId, { ...f.spec,
    env: { MIKKA_DECISION_MCP_TRACEPARENT: '', UNREVIEWED_ENV: 'PRIVATE_SYNTHETIC_VALUE' } })
  try {
    expect(() => readMcpContext(...bound.server.args.slice(1) as [string, string, string])).toThrow('mcp_context_invalid')
    expect(await request(bound.server.command, bound.server.args)).toEqual({
      code: 2, out: '', err: 'mikka-mcp: run context unavailable\n',
    })
  } finally { bound.close() }
})
