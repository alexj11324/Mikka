import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClaudeAdapter } from '../src/adapters/claude'
import { CodexAdapter } from '../src/adapters/codex'
import { CursorAdapter } from '../src/adapters/cursor'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { buildChildEnv } from '../src/env'
import { createLogger } from '../src/log'

for (const kind of ['claude_code', 'codex', 'cursor'] as const) test(`${kind} receives only the per-run proxy supplied by the trusted host`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-local-adapter-'))
  t.after(() => { console.log(`Retained local adapter test directory: ${root}`) })
  const home = join(root, 'home')
  await mkdir(home)
  const expected = { command: '/synthetic/node', args: ['/synthetic/proxy', '/synthetic/socket', 'synthetic-token'], env: {} }
  const calls: string[] = []
  const provider = (runId: string) => { calls.push(runId); return runId === 'allowed' ? expected : undefined }
  const common = { stateDir: join(root, 'state'), computerProvider: provider }
  const adapter = kind === 'claude_code'
    ? new ClaudeAdapter({ ...common, binary: resolve('test/fakes/fake-claude.mjs'), sandbox: new NoSandbox(), configDir: join(home, '.claude') })
    : kind === 'codex'
      ? new CodexAdapter({ ...common, binary: resolve('test/fakes/fake-codex.mjs'), sandbox: new NoSandbox(), userHome: home })
      : new CursorAdapter({ ...common, binary: resolve('test/fakes/fake-acp.mjs'), sandbox: new NoSandbox() })
  for (const runId of ['allowed', 'denied']) {
    // This fixture only inspects configuration; no tool operation is granted.
    const toolApproval = new ToolApprovalGate(runId, {
      isLive: id => id === runId,
    })
    try {
      const session = await adapter.start({ runId, toolApproval, cwd: resolve('../..'), env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }), log: createLogger({ level: 'silent' }), prompt: 'COMPUTER_CONFIG_TEST' })
      const chunks = []
      for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') chunks.push(event.chunk.delta)
      const found = JSON.parse(chunks.join('')).computer
      if (runId === 'allowed') assert.deepEqual({ command: found.command, args: found.args, env: found.env }, expected)
      else assert.equal(found, null)
    } finally { toolApproval.revoke() }
  }
  assert.deepEqual(calls, ['allowed', 'denied'])
})
