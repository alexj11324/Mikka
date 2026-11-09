#!/usr/bin/env node
// Mikka's MCP server for agent CLIs: the explicit hand-in tools a real
// harness calls instead of just ending its turn (`submit`, `ask_human`,
// `report_blocked`). It runs inside the agent's sandbox as a stdio child of
// the CLI, with no dependencies, and records the call in the handoff file
// (in the worktree's git dir, writable from the sandbox). The daemon reads
// that file when the turn ends; the file, not the CLI's event stream, is the
// one source of truth for every harness.
//
//   node mikka-mcp.mjs --handoff <file> [--captures <dir> --capture-root <dir>...]
//
// `submit_capture` copies a screenshot or recording the agent made into the
// captures dir; the daemon checks it again and uploads it to the run.
//
// Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0.
import { createInterface } from 'node:readline'
import { createMikkaMcpBackend } from './mikka-mcp-backend.mjs'

const handoffIndex = process.argv.indexOf('--handoff')
const handoffFile = handoffIndex > 0 ? process.argv[handoffIndex + 1] : null
if (!handoffFile) {
  process.stderr.write('mikka-mcp: --handoff <file> is required\n')
  process.exit(2)
}
const value = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined }
const values = flag => process.argv.flatMap((arg, i) => arg === flag && process.argv[i + 1] ? [process.argv[i + 1]] : [])
const backend = createMikkaMcpBackend({
  handoffFile, capturesDir: values('--captures')[0] ?? null, captureRoots: values('--capture-root'),
  factoryVerify: value('--factory-verify') === undefined ? null : JSON.parse(value('--factory-verify')),
  artifactRoot: value('--factory-artifacts'), repositoryRoot: value('--repository-selection'),
  decisionUrl: process.env.MIKKA_DECISION_MCP_URL, decisionToken: process.env.MIKKA_DECISION_MCP_TOKEN,
  decisionCatalogue: process.env.MIKKA_DECISION_MCP_CATALOGUE,
  decisionTraceparent: process.env.MIKKA_DECISION_MCP_TRACEPARENT,
  observationUrl: process.env.MIKKA_MCP_HTTP_OBSERVATION_URL, env: process.env,
})
const send = response => { if (response) process.stdout.write(JSON.stringify(response) + '\n') }
createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return }
  void backend.handle(message).then(send).catch(() => send({
    jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: 'Mikka tool unavailable' },
  }))
}).once('close', () => { void backend.close() })
