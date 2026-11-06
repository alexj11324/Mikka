// Synthetic Codex app-server peer for isolated HTTP trace acceptance. This is
// never an official CLI or a provider: version/model/usage are fixture values.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { callMcpTool } from '../../packages/daemon/test/fakes/mcp-call.mjs'
import { MVP_NATIVE_ACCOUNT, MVP_NATIVE_TOKEN, MVP_SUBSCRIPTION_MODEL } from './subscription.mjs'

/** Only the guarded fixture launcher selects this binary via the existing
 * DaemonOptions.harnessBinaries test seam. No production entry imports it. */
export function createTraceCodexBinary(directory, fixture) {
  const version = JSON.parse(readFileSync(new URL('../../packages/daemon/harness/pins.json', import.meta.url), 'utf8')).harnesses.codex.version
  const binary = join(directory, 'synthetic-codex.mjs')
  writeFileSync(binary, `#!/usr/bin/env node\nimport { runTraceCodex } from ${JSON.stringify(import.meta.url)}\nawait runTraceCodex(${JSON.stringify({ version, fixture: resolve(fixture), directory: resolve(directory) })})\n`, { mode: 0o700 })
  return binary
}

export async function runTraceCodex(config) {
  if (process.argv[2] === '--version') { process.stdout.write(`codex-cli ${config.version}\n`); return }
  assert.equal(process.argv[2], 'app-server', 'SYNTHETIC_CODEX_METHOD_REQUIRED')
  assert.ok(process.env.CODEX_HOME && !relative(config.directory, process.env.CODEX_HOME).startsWith('..'), 'SYNTHETIC_CODEX_HOME_REQUIRED')
  assert.ok(!process.env.OPENAI_API_KEY && !existsSync(join(process.env.CODEX_HOME, 'auth.json')), 'SYNTHETIC_CODEX_AUTH_FILE_REFUSED')
  const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  const mcp = { command: '', args: [], env: {} }
  for (let index = 3; index < process.argv.length; index++) {
    if (process.argv[index] !== '-c') continue
    const value = process.argv[++index], separator = value.indexOf('='), key = value.slice(0, separator)
    if (!key.startsWith('mcp_servers.mikka.')) continue
    const parsed = JSON.parse(value.slice(separator + 1))
    if (key === 'mcp_servers.mikka.command') mcp.command = parsed
    if (key === 'mcp_servers.mikka.args') mcp.args = parsed
    if (key.startsWith('mcp_servers.mikka.env.')) mcp.env[key.slice('mcp_servers.mikka.env.'.length)] = parsed
  }
  let initialized = false, authenticated = false, threadId, activeTurn, turn = 0
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    const { id, method, params } = request
    try {
      if (method === 'initialize') {
        initialized = true
        send({ id, result: { userAgent: `codex_cli_rs/${config.version} synthetic-trace-fixture` } })
      } else if (method === 'model/list') {
        assert.ok(initialized)
        send({ id, result: { data: [{ id: MVP_SUBSCRIPTION_MODEL, model: MVP_SUBSCRIPTION_MODEL, displayName: 'Synthetic trace model', isDefault: true }], nextCursor: null } })
      } else if (method === 'account/login/start') {
        assert.ok(initialized)
        assert.equal(params.type, 'chatgptAuthTokens')
        assert.equal(params.accessToken, MVP_NATIVE_TOKEN)
        assert.equal(params.chatgptAccountId, MVP_NATIVE_ACCOUNT)
        authenticated = true
        send({ id, result: { type: 'chatgptAuthTokens' } })
      } else if (method === 'thread/start') {
        assert.ok(authenticated)
        assert.equal(params.model, MVP_SUBSCRIPTION_MODEL)
        assert.equal(resolve(params.cwd), process.cwd())
        threadId = `synthetic-${randomUUID()}`
        send({ id, result: { thread: { id: threadId }, model: MVP_SUBSCRIPTION_MODEL } })
      } else if (method === 'turn/start') {
        assert.ok(authenticated && threadId && params.threadId === threadId)
        const turnId = `synthetic-turn-${++turn}`
        activeTurn = turnId
        send({ id, result: { turn: { id: turnId } } })
        send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', error: null } } })
        // Do not inspect or record the prompt. Replay only the host-selected
        // fixture; the real MCP submit must accept the run's current authority.
        const fixture = readFileSync(config.fixture, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const failed = fixture.find(part => part.exit?.outcome === 'failed')
        if (!failed) {
          for (const part of fixture) {
            assert.ok(!part.exec, 'SYNTHETIC_CODEX_SHELL_REFUSED')
            if (part.write) {
              assert.equal(part.write.path, 'MIKKA_MOCK.md')
              writeFileSync(join(process.cwd(), part.write.path), part.write.content)
              send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'fileChange', id: 'synthetic-write', changes: [{ path: part.write.path, kind: { type: 'add' } }], status: 'completed' } } })
            }
            if (part.submit) {
              assert.ok(mcp.command && mcp.args.length, 'SYNTHETIC_CODEX_MCP_REQUIRED')
              const reply = await callMcpTool(mcp, 'submit', part.submit)
              assert.ok(reply.result && !reply.result.isError, 'SYNTHETIC_CODEX_SUBMIT_REFUSED')
            }
          }
          assert.ok(fixture.some(part => part.submit), 'SYNTHETIC_CODEX_SUBMIT_REQUIRED')
        }
        // Exercise the real adapter's per-generation parser with labelled,
        // deterministic synthetic counters, including the last-vs-total ABI.
        send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 }, last: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 1 } } } })
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: failed ? 'failed' : 'completed', error: failed ? { message: failed.exit.error } : null } } })
        activeTurn = undefined
      } else if (method === 'turn/interrupt') send({ id, result: {} })
      else send({ id, error: { code: -32601, message: 'synthetic_method_unsupported' } })
    } catch {
      send({ id, error: { code: -32603, message: 'synthetic_fixture_refused' } })
      if (activeTurn) {
        send({ method: 'turn/completed', params: { threadId, turn: { id: activeTurn, status: 'failed', error: { message: 'synthetic_fixture_refused' } } } })
        activeTurn = undefined
      }
    }
  }
}
