import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertMvpEnvironment, MVP_ORIGIN } from '../tests/mvp/isolated-env.mjs'
import { startMvpServices } from '../tests/mvp/services.mjs'

assertMvpEnvironment()
const services = await startMvpServices()
const workflowDirectory = await mkdtemp(join(tmpdir(), 'mikka-mvp-workflow-'))
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const preload = fileURLToPath(new URL('../tests/mvp/preload.mjs', import.meta.url))
const child = spawn(process.execPath, ['--import', preload, 'node_modules/next/dist/bin/next', 'start', '--port', '3100'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
  env: { ...process.env, AI_GATEWAY_API_KEY: 'mvp-synthetic-gateway', DECISION_GATEWAY_API_KEY: '',
    GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_BASE_URL: `${MVP_ORIGIN}/mikka`, WORKFLOW_LOCAL_DATA_DIR: workflowDirectory },
})
const childDone = new Promise(resolve => {
  child.once('exit', code => resolve(code ?? 0))
  child.once('error', () => resolve(1))
})
let closing = false
async function close(signal = 'SIGTERM') {
  if (closing) return
  closing = true
  child.kill(signal)
  const timer = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
  await childDone
  clearTimeout(timer)
  await services.close()
  await rm(workflowDirectory, { recursive: true, force: true })
}
process.on('SIGTERM', () => { void close() })
process.on('SIGINT', () => { void close('SIGINT') })
void childDone.then(async code => { await close(); process.exitCode = code })
