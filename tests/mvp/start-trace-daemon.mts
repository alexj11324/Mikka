// Real CLI, HTTP transport, journal, repo/worktree manager and mock adapter.
// No real provider generation or E2B runtime is claimed by this fixture.
import { runCli } from '../../packages/daemon/src/cli'
import { daemonTracer } from '../../packages/daemon/src/tracing'
import { sanitizeTraceContext } from '@mikka/protocol/trace-context'
import { assertMvpEnvironment, MVP_ORIGIN } from './isolated-env.mjs'

assertMvpEnvironment()
const directory = process.env.MIKKA_E2E_DAEMON_DIR, token = process.env.MIKKA_E2E_DEVICE_TOKEN
const fixtures = process.env.MIKKA_TRACE_FIXTURES_DIR
const traceContext = sanitizeTraceContext(JSON.parse(process.env.MIKKA_TRACE_FIXTURE_CONTEXT ?? '{}'))
if (!directory || !token || !fixtures || !traceContext) throw new Error('TRACE_DAEMON_FIXTURE_REQUIRED')
delete process.env.MIKKA_E2E_DEVICE_TOKEN
// A synthetic equivalent of the cloud's public bootstrap config, before first registration.
daemonTracer.configure({ endpoint: 'http://127.0.0.1:3196/i/v1/traces', projectToken: 'phc_trace_fixture_1512', sampleRate: 1, environment: 'dev' })
await daemonTracer.withContext(traceContext, async () => {
  const result = await runCli(['daemon', 'login', '--token', token, '--data-dir', directory, '--server', `${MVP_ORIGIN}/mikka`])
  if (result !== 0) throw new Error('TRACE_DAEMON_LOGIN_FAILED')
  const code = await runCli(['daemon', '--data-dir', directory, '--server', `${MVP_ORIGIN}/mikka`, '--mock-speed', '100', '--fixtures-dir', fixtures, '--retain-resources'])
  if (code !== null) process.exitCode = code
})
