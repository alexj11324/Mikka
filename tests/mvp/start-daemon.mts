import { resolve } from 'node:path'
import { runCli } from '../../packages/daemon/src/cli'
import { assertMvpEnvironment, MVP_ORIGIN } from './isolated-env.mjs'

assertMvpEnvironment()
const dataDir = process.env.MIKKA_E2E_DAEMON_DIR
const token = process.env.MIKKA_E2E_DEVICE_TOKEN
if (!dataDir || !token) throw new Error('Missing disposable daemon fixture')
delete process.env.MIKKA_E2E_DEVICE_TOKEN
// Exercise the actual supported --token login, then the actual CLI/HTTP daemon.
const login = await runCli(['daemon', 'login', '--token', token, '--data-dir', dataDir, '--server', `${MVP_ORIGIN}/mikka`])
if (login !== 0) throw new Error('The real daemon token login failed')
const code = await runCli(['daemon', '--data-dir', dataDir, '--server', `${MVP_ORIGIN}/mikka`, '--mock-speed', '1', '--fixtures-dir', resolve('tests/mvp/fixtures'), '--retain-resources'])
if (code !== null) process.exitCode = code
