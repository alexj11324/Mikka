import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))

test('packed CLI runs outside the workspace with declared public dependencies and no TypeScript loader', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'mikka-package-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const packed = JSON.parse(execFileSync('npm', ['pack', join(root, 'dist'), '--json', '--ignore-scripts', '--pack-destination', temporary, '--cache', join(temporary, 'npm-cache')], { encoding: 'utf8' }))[0]
  assert.ok(packed.files.length > 10)
  assert.ok(packed.files.every(file => !file.path.endsWith('.ts') && !file.path.startsWith('node_modules/')))
  execFileSync('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary])
  const installed = join(temporary, 'package')
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.private, false)
  assert.equal(manifest.bin.mikka, './mikka.js')
  assert.ok(!manifest.dependencies['@mikka/protocol'])
  assert.ok(!manifest.dependencies.tsx)
  assert.ok(Object.values(manifest.dependencies).every(version => !version.startsWith('workspace:')))
  for (const path of Object.values(manifest.exports)) assert.ok((await readFile(join(installed, path))).length > 0)
  // The temporary install has only the declared public dependencies. No
  // workspace, loader, protocol package or source path is made available.
  for (const dependency of Object.keys(manifest.dependencies)) {
    const target = join(installed, 'node_modules', dependency)
    await mkdir(dirname(target), { recursive: true })
    await symlink(await realpath(join(root, 'node_modules', dependency)), target)
  }
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8' }
  const command = join(installed, 'mikka.js')
  const help = execFileSync(process.execPath, [command, '--help'], { encoding: 'utf8', cwd: temporary, env })
  assert.match(help, /mikka daemon login/)
  const data = join(temporary, 'data')
  const token = `orv_${'t'.repeat(43)}`
  execFileSync(process.execPath, [command, 'daemon', 'login', '--token', token, '--data-dir', data], { cwd: temporary, env })
  assert.equal(JSON.parse(await readFile(join(data, 'device.json'), 'utf8')).credential, token)
  // These child scripts are resolved relative to bundled entries at runtime.
  for (const asset of ['mikka-mcp.mjs', 'agents/native-container.mjs', 'computer/proxy.mjs', 'computer/driver.mjs', 'fixtures/success-edit.jsonl']) {
    assert.ok((await readFile(join(installed, asset))).length > 0)
  }
})
