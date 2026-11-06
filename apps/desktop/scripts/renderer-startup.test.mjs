import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { Window } from 'happy-dom'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
let imports = 0
async function fixture(t, pathname = '/mikka') {
  const window = new Window({ url: `mikka://app${pathname}` })
  const descriptors = new Map(['window', 'fetch', '__workspaceImported', '__workspaceRendered'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window })
  globalThis.__workspaceImported = 0
  globalThis.__workspaceRendered = 0
  t.after(async () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
    await window.happyDOM.close()
  })
  const result = await build({
    absWorkingDir: repository, stdin: {
      contents: 'export { loadWorkspace, preloadWorkspace } from "./apps/desktop/src/renderer/workspace-loader"; export { readBootstrap } from "./apps/desktop/src/renderer/bootstrap"',
      resolveDir: repository, loader: 'ts',
    }, write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2023',
    tsconfig: join(repository, 'apps/desktop/tsconfig.renderer.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.MIKKA_BASE_PATH': '"/mikka"', 'process.env': '{}' },
    plugins: [{ name: 'local-workspace-module-fixture', setup(builder) {
      builder.onResolve({ filter: /^\.\/workspace$/ }, args => args.importer.endsWith('workspace-loader.ts') ? { path: 'workspace', namespace: 'startup-fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'startup-fixture' }, () => ({ contents: 'globalThis.__workspaceImported++; export default function Workspace() { globalThis.__workspaceRendered++; return null }', loader: 'js' }))
    } }],
  })
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${++imports}`)
  return { window, module }
}

test('retained-account local module loading overlaps the real bootstrap promise without mounting or an extra backend read', async t => {
  const { window, module } = await fixture(t)
  window.mikka = { bundled: { session: async () => ({ user: { id: 'owner' }, session: { id: 'session' } }) } }
  let finish, requests = 0, bootstrapFinished = false
  globalThis.fetch = async () => { requests++; return new Promise(resolve => { finish = resolve }) }
  const bootstrap = module.readBootstrap().then(value => { bootstrapFinished = true; return value })
  await module.preloadWorkspace()
  assert.equal(requests, 1)
  assert.equal(bootstrapFinished, false)
  assert.equal(globalThis.__workspaceImported, 1)
  assert.equal(globalThis.__workspaceRendered, 0, 'a retained identity never mounts an authorized surface by itself')
  const loading = module.loadWorkspace()
  assert.equal(module.loadWorkspace(), loading, 'React.lazy joins exactly the warmed module promise')
  finish(Response.json({ version: 1, ok: true, result: {
    user: { id: 'owner', email: 'owner@example.invalid', name: 'Fixture' }, session: { id: 'session' }, cacheWorkspace: null,
    googleEnabled: true, githubEnabled: true, emailEnabled: true, onboarding: false, computer: 'none',
  } }))
  assert.equal((await bootstrap).user.id, 'owner')
  assert.equal(requests, 1)
  assert.equal(globalThis.__workspaceImported, 1)
})

test('signed-out root and public/auth routes do not preload the workspace graph', async t => {
  for (const pathname of ['/mikka', '/mikka/en/sign-in', '/mikka/en/a/public-share']) {
    await t.test(pathname, async t => {
      const { window, module } = await fixture(t, pathname)
      let sessions = 0
      window.mikka = { bundled: { session: async () => { sessions++; return null } } }
      globalThis.fetch = async () => { throw new Error('preloading must not fetch application data') }
      await module.preloadWorkspace()
      assert.equal(globalThis.__workspaceImported, 0)
      assert.equal(globalThis.__workspaceRendered, 0)
      assert.equal(sessions, pathname === '/mikka' ? 1 : 0)
    })
  }
})

test('failure of the optional main identity hint leaves the normal bootstrap and lazy path available', async t => {
  const { window, module } = await fixture(t)
  const cause = new Error('fixture IPC unavailable')
  window.mikka = { bundled: { session: async () => { throw cause } } }
  await assert.rejects(module.preloadWorkspace(), error => error === cause)
  assert.equal(globalThis.__workspaceImported, 0)
  assert.equal(typeof (await module.loadWorkspace()).default, 'function')
})
