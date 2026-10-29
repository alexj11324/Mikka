import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertMvpEnvironment, MVP_ORIGIN } from '../tests/mvp/isolated-env.mjs'
import { startMvpServices } from '../tests/mvp/services.mjs'
import { finishMvpResources, indexMvpResource } from '../tests/mvp/retention.mjs'
import { Pool } from 'pg'
import { loadEnvironment } from './test-accounts/environment.mjs'
import { TestAccountPool } from './test-accounts/pool.mjs'

assertMvpEnvironment()
const environment = await loadEnvironment()
const accountsDatabase = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
try {
  // Two mutating MVP cases retain/quarantine their pairs. Leave two clean pairs
  // available to the ordinary browser regression that follows this stage.
  await new TestAccountPool(accountsDatabase, environment).prepare({ pairs: 4 })
} finally { await accountsDatabase.end() }
const database = new URL(process.env.E2E_DATABASE_URL)
await indexMvpResource('database-target', `${database.hostname}:${database.port || '5432'}${database.pathname}`)
await startMvpServices()
const workflowDirectory = await mkdtemp(join(tmpdir(), 'mikka-mvp-workflow-'))
await indexMvpResource('workflow-directory', workflowDirectory)
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const preload = fileURLToPath(new URL('../tests/mvp/preload.mjs', import.meta.url))
const child = spawn(process.execPath, ['--import', preload, 'node_modules/next/dist/bin/next', 'start', '--port', '3100'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
  env: { ...process.env, AI_GATEWAY_API_KEY: '', DECISION_GATEWAY_API_KEY: '',
    GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_BASE_URL: `${MVP_ORIGIN}/mikka`, WORKFLOW_LOCAL_DATA_DIR: workflowDirectory },
})
const childDone = new Promise(resolve => {
  child.once('exit', code => resolve(code ?? 0))
  child.once('error', () => resolve(1))
})
let closing = false
async function close() {
  if (closing) return
  closing = true
  await finishMvpResources()
}
process.on('SIGTERM', () => { void close() })
process.on('SIGINT', () => { void close() })
void childDone.then(async code => { await close(); process.exitCode = code })
