import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Window } from 'happy-dom'

// Use the actual production scheduler: act()/fake clocks would flush away the
// lazy-first-read fallback that this startup regression needs to exercise.
process.env.NODE_ENV = 'production'
const window = new Window({ url: 'http://localhost/' })
const descriptors = new Map()
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'MutationObserver', 'navigator']) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : window[key] })
}
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const require = createRequire(import.meta.url)
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const renderer = resolve(repository, 'apps/desktop/src/renderer')
const directory = await mkdtemp(join(tmpdir(), 'mikka-installed-workspace-'))
const key = Symbol.for('mikka.test.installed-workspace')
const compiled = await build({
  absWorkingDir: repository,
  stdin: {
    contents: 'export { InstalledWorkspace } from "./installed-workspace"; export { loadWorkspace, readLoadedWorkspace } from "./workspace-loader";',
    resolveDir: renderer, sourcefile: 'workspace-regression.ts', loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', write: false,
  define: { 'process.env.MIKKA_BASE_PATH': '"/mikka"' },
  plugins: [{
    name: 'workspace-module-and-view-fixtures',
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: require.resolve(args.path), external: true }))
      builder.onResolve({ filter: /^@\/lib\/base-path$/ }, () => ({ path: resolve(repository, 'lib/base-path.ts') }))
      builder.onResolve({ filter: /^@\/components\/workspace\/workspace-loading$/ }, () => ({ path: 'loading', namespace: 'fixture' }))
      builder.onResolve({ filter: /^\.\/workspace$/ }, args => {
        assert.equal(args.importer, resolve(renderer, 'workspace-loader.ts'))
        return { path: 'workspace', namespace: 'fixture' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
        contents: args.path === 'workspace'
          ? 'const fixture = globalThis[Symbol.for("mikka.test.installed-workspace")]; fixture.moduleEvaluations++; const module = await fixture.module; export default module.default;'
          : 'import { createElement, useLayoutEffect } from "react"; export function WorkspaceLoading() { useLayoutEffect(() => { globalThis[Symbol.for("mikka.test.installed-workspace")].fallbacks++ }, []); return createElement("span", { id: "workspace-fallback" }, "Loading"); }',
        loader: 'js',
      }))
    },
  }],
})
const filename = join(directory, 'boundary.mjs')
await writeFile(filename, compiled.outputFiles[0].contents)
after(async () => {
  delete globalThis[key]
  await window.happyDOM.close()
  await rm(directory, { recursive: true, force: true })
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

const waitFor = async predicate => {
  const deadline = performance.now() + 3000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'WORKSPACE_REACT_REGRESSION_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
let sequence = 0
async function fixture(t) {
  let finish, reject, authenticate, refresh
  const module = new Promise((resolve, fail) => { finish = resolve; reject = fail })
  const state = { module, moduleEvaluations: 0, mounts: 0, fallbacks: 0, errors: 0 }
  globalThis[key] = state
  function Workspace({ bootstrap }) {
    const [value, setValue] = React.useState(0)
    React.useLayoutEffect(() => { state.mounts++ }, [])
    return React.createElement('button', {
      id: 'workspace', 'data-revision': bootstrap.revision,
      onClick: () => setValue(current => current + 1),
    }, String(value))
  }
  const loaded = await import(`${pathToFileURL(filename).href}?case=${++sequence}`)
  class Boundary extends React.Component {
    state = { failed: false }
    static getDerivedStateFromError() { return { failed: true } }
    componentDidCatch() { state.errors++ }
    render() { return this.state.failed ? React.createElement('span', { id: 'workspace-error' }, 'Error') : this.props.children }
  }
  function App() {
    const [signedIn, setSignedIn] = React.useState(false)
    const [revision, setRevision] = React.useState(0)
    React.useLayoutEffect(() => { authenticate = () => setSignedIn(true); refresh = () => setRevision(value => value + 1) }, [])
    return React.createElement(Boundary, null, signedIn
      ? React.createElement(loaded.InstalledWorkspace, { user: { id: 'fixture-owner' }, bootstrap: { revision } })
      : React.createElement('span', { id: 'authentication' }, 'Authentication'))
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container, { onCaughtError() {} })
  t.after(() => { root.unmount(); container.remove() })
  root.render(React.createElement(App))
  await waitFor(() => typeof authenticate === 'function')
  return {
    ...loaded, state, complete: () => finish({ default: Workspace }), reject,
    authenticate: () => authenticate(), refresh: () => refresh(), workspace: Workspace,
  }
}

test('a completed preload waits for authentication, then renders synchronously without a fallback', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const loading = f.loadWorkspace()
  assert.equal(f.loadWorkspace(), loading)
  f.complete()
  await loading
  assert.equal(f.readLoadedWorkspace(), f.workspace)
  assert.equal(f.state.mounts, 0)
  assert.ok(document.getElementById('authentication'))
  f.authenticate()
  await waitFor(() => document.getElementById('workspace'))
  assert.equal(f.state.fallbacks, 0)
  assert.equal(f.state.moduleEvaluations, 1)
  assert.equal(f.state.mounts, 1)
})

test('an unfinished preload keeps normal Suspense and never changes component type after resolving', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const loading = f.loadWorkspace()
  assert.equal(f.readLoadedWorkspace(), undefined)
  f.authenticate()
  await waitFor(() => document.getElementById('workspace-fallback'))
  assert.equal(f.state.mounts, 0)
  f.complete()
  await loading
  await waitFor(() => document.getElementById('workspace'))
  document.getElementById('workspace').click()
  await waitFor(() => document.getElementById('workspace').textContent === '1')
  f.refresh()
  await waitFor(() => document.getElementById('workspace').getAttribute('data-revision') === '1')
  assert.equal(document.getElementById('workspace').textContent, '1')
  assert.equal(f.state.mounts, 1)
  assert.equal(f.state.moduleEvaluations, 1)
  assert.equal(f.state.fallbacks, 1)
})

test('a rejected preload is never promoted to a resolved component and reaches the normal error boundary', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const failure = new Error('fixture-module-rejected')
  const loading = f.loadWorkspace()
  const caught = assert.rejects(loading, error => error === failure)
  f.reject(failure)
  await caught
  assert.equal(f.readLoadedWorkspace(), undefined)
  f.authenticate()
  await waitFor(() => document.getElementById('workspace-error'))
  assert.equal(f.state.mounts, 0)
  assert.equal(f.state.errors, 1)
  assert.equal(f.state.moduleEvaluations, 1)
})
