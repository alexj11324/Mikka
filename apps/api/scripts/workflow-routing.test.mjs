import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build, createNitro, prepare } from 'nitro/builder'
import { selfHostedEnvironment } from '../../../scripts/self-hosted-start.mjs'
import { nodeRuntimePackages, workflowNodeExternals } from '../build-contract.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const applicationRequire = createRequire(join(repository, 'package.json'))
const localRequire = createRequire(applicationRequire.resolve('@workflow/world-local'))
const { createWorkflowUrl } = await import(pathToFileURL(localRequire.resolve('@workflow/utils')).href)

async function unusedPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

test('standalone startup targets the actual Nitro Workflow consumer outside the application base path', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-workflow-routing-'))
  let nitro, child, exited, readyTimer
  try {
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir')
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'mikka-workflow-routing-test', type: 'module', private: true }))
    const fallback = join(root, 'fallback.mjs')
    await writeFile(fallback, "export default () => Response.json({ error: 'Not found' }, { status: 404 })\n")
    nitro = await createNitro({
      rootDir: root, workspaceDir: root, serverDir: false,
      preset: 'node-server', builder: 'rolldown', logLevel: 0,
      routes: { '/**': fallback },
      modules: [workflowNodeExternals, fileURLToPath(import.meta.resolve('workflow/nitro'))],
      plugins: [join(repository, 'apps/api/plugins/workflow-world.ts')],
      workflow: { dirs: ['.'], runtime: 'nodejs24.x', dashboard: false, sourcemap: false },
      buildDir: join(root, 'build'), output: { dir: join(root, 'output') },
      rolldownConfig: { external: nodeRuntimePackages },
      traceDeps: ['@workflow/world-local*'],
      sourcemap: false, compatibilityDate: '2026-11-05',
    }, { dotenv: false })
    await prepare(nitro)
    await build(nitro)
    // Run the actual production Node listener and generated SDK handler. No
    // source node_modules may rescue an incomplete standalone bundle.
    await rm(join(root, 'node_modules'), { recursive: true })
    const port = await unusedPort(), origin = `http://127.0.0.1:${port}`
    const env = selfHostedEnvironment({
      PATH: process.env.PATH, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
      BETTER_AUTH_URL: origin, DATABASE_URL: 'postgres://unused:fixture@127.0.0.1:1/unused',
      MIKKA_DATA_DIR: join(root, 'data'),
    }, root)
    let output = ''
    child = spawn(process.execPath, [join(nitro.options.output.serverDir, 'index.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    exited = once(child, 'exit')
    await new Promise((resolve, reject) => {
      readyTimer = setTimeout(() => reject(new Error(`WORKFLOW_LISTENER_TIMEOUT: ${output}`)), 15_000)
      child.once('error', reject)
      child.once('exit', () => reject(new Error(`WORKFLOW_LISTENER_EXITED: ${output}`)))
      const read = chunk => { output += chunk; if (output.includes('Listening on:')) resolve() }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
    })
    clearTimeout(readyTimer)

    // Use the installed SDK's URL constructor: it appends to (and preserves)
    // baseUrl.pathname. An app-prefixed default reaches the 404 fallback.
    const health = createWorkflowUrl(env.WORKFLOW_LOCAL_BASE_URL, { type: 'health' })
    const response = await fetch(health, { signal: AbortSignal.timeout(5_000) })
    const healthBody = await response.text()
    assert.equal(response.status, 200, `${health}: ${healthBody}`)
    assert.equal(JSON.parse(healthBody).healthy, true)
    assert.equal(JSON.parse(healthBody).endpoint, '/.well-known/workflow/v1/flow')
    assert.equal(new URL(health).pathname, '/.well-known/workflow/v1/flow')
    const flow = createWorkflowUrl(env.WORKFLOW_LOCAL_BASE_URL, { type: 'flow' })
    const invalidDelivery = await fetch(flow, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000) })
    assert.equal(invalidDelivery.status, 400)
    assert.equal((await invalidDelivery.json()).error, 'Missing required headers')
    const misplaced = await fetch(`${origin}/mikka/.well-known/workflow/v1/flow?__health`, { signal: AbortSignal.timeout(5_000) })
    assert.equal(misplaced.status, 404, 'the application base path is not the SDK consumer mount')
  } finally {
    clearTimeout(readyTimer)
    if (child && child.exitCode === null) {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5_000)
      child.kill('SIGTERM')
      await exited
      clearTimeout(kill)
    }
    await nitro?.close()
    await rm(root, { recursive: true, force: true })
  }
})
