// Real CLI login, HTTP transport, journal, repo/worktree and Codex adapter.
// Only the app-server process is a labelled synthetic protocol peer.
// No real provider generation or E2B runtime is claimed by this fixture.
import { delimiter, dirname, join } from 'node:path'
import { runCli } from '../../packages/daemon/src/cli'
import { startDaemon, DAEMON_VERSION } from '../../packages/daemon/src/main'
import { HttpServerLink } from '../../packages/daemon/src/server-link-http'
import { NoSandbox } from '../../packages/daemon/src/agents/sandbox'
import { daemonTracer } from '../../packages/daemon/src/tracing'
import { localGitOrigin } from '../../packages/daemon/src/agents/local-git-origin'
import { sanitizeTraceContext } from '@mikka/protocol/trace-context'
import { assertMvpEnvironment, MVP_ORIGIN } from './isolated-env.mjs'
import { createTraceCodexBinary, createTraceGitHubBinary } from './trace-codex.mjs'
import { observeTraceMcpFetch } from './diagnostics.mjs'

assertMvpEnvironment()
const directory = process.env.MIKKA_E2E_DAEMON_DIR, token = process.env.MIKKA_E2E_DEVICE_TOKEN
const fixtures = process.env.MIKKA_TRACE_FIXTURES_DIR
const traceContext = sanitizeTraceContext(JSON.parse(process.env.MIKKA_TRACE_FIXTURE_CONTEXT ?? '{}'))
if (!directory || !token || !fixtures || !traceContext) throw new Error('TRACE_DAEMON_FIXTURE_REQUIRED')
const barePath = localGitOrigin()
if (!barePath) throw new Error('SYNTHETIC_GIT_ORIGIN_REQUIRED')
const githubBinary = createTraceGitHubBinary(directory)
process.env.PATH = `${dirname(githubBinary)}${delimiter}${process.env.PATH ?? ''}`
delete process.env.MIKKA_E2E_DEVICE_TOKEN
// A synthetic equivalent of the cloud's public bootstrap config, before first registration.
daemonTracer.configure({ endpoint: 'http://127.0.0.1:3196/i/v1/traces', projectToken: 'phc_trace_fixture_1512', sampleRate: 1, environment: 'dev' })
await daemonTracer.withContext(traceContext, async () => {
  const result = await runCli(['daemon', 'login', '--token', token, '--data-dir', directory, '--server', `${MVP_ORIGIN}/mikka`])
  if (result !== 0) throw new Error('TRACE_DAEMON_LOGIN_FAILED')
  const binary = createTraceCodexBinary(directory, join(fixtures, 'mvp-core-loop.jsonl'), barePath)
  const daemon = await startDaemon({
    dataDir: directory, flavor: 'dev', link: new HttpServerLink(`${MVP_ORIGIN}/mikka`, observeTraceMcpFetch(fetch), DAEMON_VERSION),
    agentSandbox: new NoSandbox(), harnessBinaries: { codex: binary },
    harnesses: [{ harness: 'codex', installed: true, version: 'synthetic' }], modelProbe: true,
    retainResources: true, onDrained: () => process.exit(0), onLockLost: () => process.exit(1),
  })
  let stopping = false
  const stop = () => { if (!stopping) { stopping = true; void daemon.stop().then(() => process.exit(0)) } }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
})
