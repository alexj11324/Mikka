import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build, createNitro, prepare } from 'nitro/builder'
import { nodeRuntimePackages, workflowNodeExternals } from '../build-contract.mjs'

const execute = promisify(execFile)
const workflowRequire = createRequire(import.meta.resolve('workflow/runtime'))
const coreRequire = createRequire(workflowRequire.resolve('@workflow/core/runtime'))
const localPackage = dirname(dirname(coreRequire.resolve('@workflow/world-local')))
const manifest = JSON.parse(await readFile(join(localPackage, 'package.json'), 'utf8'))

// A fresh Node process matters: the SDK caches package metadata on globalThis.
// Loading an unbundled copy first would hide the actual bundling regression.
const initialize = `
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
const { createWorld } = await import(process.argv[1])
const world = createWorld({ dataDir: process.argv[2], baseUrl: 'http://127.0.0.1:1' })
try {
  await world.start()
  console.log(JSON.stringify({ initialized: true, marker: await readFile(join(process.argv[2], 'version.txt'), 'utf8') }))
} catch (error) {
  console.log(JSON.stringify({ initialized: false, name: error.name, message: error.message }))
  process.exitCode = 1
} finally {
  await world.close()
}
`

async function startLocal(entry, dataDir) {
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  return execute(process.execPath, ['--input-type=module', '-e', initialize, pathToFileURL(entry).href, dataDir],
    { env, timeout: 15_000, maxBuffer: 64 * 1024 })
}

for (const development of [true, false]) {
  test(`actual Nitro ${development ? 'development' : 'production'} output preserves Local World metadata and data-version guard`, { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mikka-local-world-build-'))
    let nitro, timer
    try {
      assert.equal(manifest.name, '@workflow/world-local')
      assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-.+)?$/)
      await mkdir(join(root, 'node_modules/@workflow'), { recursive: true })
      await symlink(localPackage, join(root, 'node_modules/@workflow/world-local'), 'dir')
      await symlink(dirname(dirname(workflowRequire.resolve('@workflow/core/runtime'))), join(root, 'node_modules/@workflow/core'), 'dir')
      await symlink(dirname(dirname(fileURLToPath(import.meta.resolve('workflow/runtime')))), join(root, 'node_modules/workflow'), 'dir')
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'mikka-local-world-test', type: 'module', private: true }))
      const entry = join(root, 'entry.mjs')
      await writeFile(entry, "export { createWorld } from '@workflow/world-local'\n")
      nitro = await createNitro({
        rootDir: root, workspaceDir: root, serverDir: false,
        dev: development, preset: development ? 'nitro-dev' : 'node-server',
        builder: 'rolldown', entry, logLevel: 0,
        modules: [workflowNodeExternals, fileURLToPath(import.meta.resolve('workflow/nitro'))],
        workflow: { dirs: ['.'], runtime: 'nodejs24.x', dashboard: false, sourcemap: false },
        buildDir: join(root, 'build'), output: { dir: join(root, 'output') },
        rolldownConfig: { external: nodeRuntimePackages },
        traceDeps: nodeRuntimePackages.filter(name => name === '@workflow/world-local').map(name => `${name}*`),
        sourcemap: false, compatibilityDate: '2026-11-05',
      }, { dotenv: false })
      const compiled = Promise.withResolvers()
      // build() installs the real development watcher; do not import a partial file.
      void compiled.promise.catch(() => {})
      if (development) {
        nitro.hooks.hookOnce('dev:reload', () => compiled.resolve())
        nitro.hooks.hookOnce('dev:error', error => compiled.reject(error))
        timer = setTimeout(() => compiled.reject(new Error('LOCAL_WORLD_BUILD_TIMEOUT')), 20_000)
      }
      await prepare(nitro)
      await build(nitro)
      if (development) await compiled.promise
      clearTimeout(timer)
      const output = join(nitro.options.output.serverDir, 'index.mjs')
      if (!development) {
        const traced = createRequire(output).resolve('@workflow/world-local')
        assert.ok(traced.startsWith(join(nitro.options.output.serverDir, 'node_modules') + '/'), 'production must resolve the traced package inside its own output')
        assert.equal(await readFile(join(dirname(dirname(traced)), 'package.json'), 'utf8'),
          await readFile(join(localPackage, 'package.json'), 'utf8'))
        // Source dependencies must not rescue an incomplete standalone output.
        await rm(join(root, 'node_modules'), { recursive: true })
      }
      const data = join(root, 'data')
      const first = JSON.parse((await startLocal(output, data)).stdout.trim())
      assert.deepEqual(first, { initialized: true, marker: `${manifest.name}@${manifest.version}` })
      const second = JSON.parse((await startLocal(output, data)).stdout.trim())
      assert.deepEqual(second, first, 'a new process must reopen the same SDK version without rewriting it')

      // The fix preserves the real SDK gate; it must not fake a semver or ignore
      // incompatible persisted data to make local startup appear successful.
      const incompatible = '@workflow/world-local@invalid'
      await writeFile(join(data, 'version.txt'), incompatible)
      await assert.rejects(startLocal(output, data), error => {
        assert.equal(error.code, 1)
        const result = JSON.parse(error.stdout.trim())
        assert.equal(result.initialized, false)
        assert.equal(result.name, 'Error')
        assert.match(result.message, /Invalid version string/)
        return true
      })
      assert.equal(await readFile(join(data, 'version.txt'), 'utf8'), incompatible)
    } finally {
      clearTimeout(timer)
      await nitro?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}
