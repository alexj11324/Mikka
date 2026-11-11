import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { dependencyCache } from './dependency-cache.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ci-dependencies-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), value)
    execFileSync('git', ['add', path], { cwd: root })
  }
  write('package.json', '{"name":"fixture","scripts":{"test":"node --test"}}')
  write('pnpm-lock.yaml', 'lockfileVersion: 9')
  write('pnpm-workspace.yaml', 'packages: [apps/*]')
  write('apps/desktop/package.json', '{"name":"@mikka/desktop"}')
  const context = { node: '24.22.1', pnpm: '10.34.3', platform: 'linux', arch: 'x64', image: 'ubuntu22', profile: 'full', electron: 'skip', nodeEnv: '' }
  return { root, write, context, key: () => dependencyCache(root, context).key }
}

test('source edits and untracked/generated node_modules never change the dependency key', t => {
  const f = fixture(t), before = f.key()
  f.write('app/page.tsx', 'export default 1')
  f.write('apps/desktop/src/main.ts', 'export default 2')
  mkdirSync(join(f.root, 'node_modules/example'), { recursive: true })
  writeFileSync(join(f.root, 'node_modules/example/package.json'), '{"name":"untracked"}')
  assert.equal(f.key(), before)
})

test('lockfile, workspace manifests, pnpm options, patches and installer invalidate installed dependencies', t => {
  const f = fixture(t)
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/desktop/package.json', '.npmrc', 'patches/runtime.patch', '.github/actions/pnpm-install/action.yml', 'scripts/ci/dependency-cache.mjs']) {
    const before = f.key()
    f.write(path, path.endsWith('package.json') ? '{"name":"changed"}' : 'changed')
    assert.notEqual(f.key(), before, path)
  }
})

test('OS, architecture, Node, pnpm, image, install profile and checkout path cannot share modules', t => {
  const f = fixture(t), before = f.key()
  for (const field of Object.keys(f.context)) {
    assert.notEqual(dependencyCache(f.root, { ...f.context, [field]: 'different' }).key, before, field)
  }
  const other = fixture(t)
  assert.notEqual(other.key(), before)
})

test('workspace lifecycle hooks and pnpmfile hooks require a fresh installation even on a matching key', t => {
  const f = fixture(t)
  assert.equal(dependencyCache(f.root, f.context).reusable, true)
  f.write('apps/desktop/package.json', '{"scripts":{"postinstall":"node scripts/setup.mjs"}}')
  assert.equal(dependencyCache(f.root, f.context).reusable, false)
  f.write('apps/desktop/package.json', '{}')
  f.write('.pnpmfile.cjs', 'module.exports = {}')
  assert.equal(dependencyCache(f.root, f.context).reusable, false)
})
