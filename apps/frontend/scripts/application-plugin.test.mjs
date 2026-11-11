import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import postcss from 'postcss'
import { applicationPlugin, repository } from './application-plugin.mjs'
import { sharedStylePlugins } from './shared-styles.mjs'

let sequence = 0
async function compile(source, target = 'web') {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-vite-contract-'))
  const entry = join(directory, 'contract.ts')
  await writeFile(entry, source)
  const plugin = await applicationPlugin(target)
  try {
    const output = await build({
      configFile: false, root: repository, publicDir: false, envDir: false, envPrefix: [], logLevel: 'silent',
      plugins: [plugin],
      define: { 'process.env.NODE_ENV': '"production"', 'process.env.MIKKA_BASE_PATH': '"/mikka"', 'process.env': '{}' },
      build: { write: false, minify: false, target: 'es2023', rolldownOptions: { input: entry, preserveEntrySignatures: 'strict' } },
    })
    const entryChunk = output.output.find(chunk => chunk.type === 'chunk' && chunk.isEntry)
    assert.ok(entryChunk)
    return { code: entryChunk.code, inventory: plugin.api.inventory() }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('the actual Vite graph preserves action arity and the web/native transport separation', async () => {
  const source = 'export { listProjects, listWorkspaceProjects } from "@/app/actions/projects"; export { getArtifact } from "@/app/actions/artifacts"; export { startCardVerification, startPointsPurchase } from "@/lib/billing/verification-client";'
  const windowBefore = globalThis.window
  const fetchBefore = globalThis.fetch
  const workspace = 'bf0f49e9-60ef-42a2-9e46-519b6010d7ef'
  try {
    for (const target of ['web', 'desktop']) {
      const { code, inventory } = await compile(source, target)
      assert.ok(inventory.usedActions.includes('projects.listProjects'))
      assert.ok(inventory.usedActions.includes('billing.startPointsPurchase'))
      assert.deepEqual(inventory.serverModules, [])
      assert.ok(inventory.inputs.every(path => !path.startsWith('app/actions/')))
      const requests = []
      globalThis.window = { location: new URL(target === 'web' ? 'https://app.example/mikka/en' : 'mikka://app/mikka/en') }
      globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json({ version: 1, ok: true, result: null }) }
      const actions = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#vite-contract-${++sequence}`)
      await actions.listProjects('ignored SWR key')
      await actions.listWorkspaceProjects(workspace, 'ignored SWR key')
      await actions.getArtifact('artifact-id', 'ignored extra argument')
      await actions.startCardVerification(workspace)
      await actions.startPointsPurchase(workspace, 25)
      assert.deepEqual(requests.map(request => JSON.parse(request.options.body)), [
        { version: 1, action: 'projects.listProjects', args: [] },
        { version: 1, action: 'projects.listWorkspaceProjects', args: [workspace] },
        { version: 1, action: 'artifacts.getArtifact', args: ['artifact-id'] },
        { version: 1, action: 'billing.startCardVerification', args: [workspace] },
        { version: 1, action: 'billing.startPointsPurchase', args: [workspace, 25] },
      ])
      assert.ok(requests.every(request => request.url === `/mikka/api/${target === 'web' ? '' : 'desktop/'}rpc`))
      assert.ok(requests.every(request => request.options.credentials === (target === 'web' ? 'same-origin' : 'omit')))
      assert.ok(requests.every(request => !Object.hasOwn(request.options.headers, 'authorization')))
    }
  } finally { globalThis.window = windowBefore; globalThis.fetch = fetchBefore }
})

test('actual Vite resolution rejects server runtime and unregistered action consumers before output', async () => {
  for (const source of [
    'import "node:fs"',
    'import "next/headers"',
    'import "server-only"',
    'import "@/lib/auth"',
  ]) await assert.rejects(compile(source), /FRONTEND_SERVER_(?:IMPORT|MODULE)/)
  await assert.rejects(compile('export { shareCapture } from "@/app/actions/captures"'), /FRONTEND_ACTION_NOT_ALLOWED: captures.shareCapture/)
})

test('actual emitted CommonJS and ESM syntax themes retain their conditional export semantics', async () => {
  const require = createRequire(import.meta.url)
  const commonjs = require.resolve('react-syntax-highlighter/dist/cjs/styles/prism')
  const esm = require.resolve('react-syntax-highlighter/dist/esm/styles/prism/coldark-dark')
  const expected = require('react-syntax-highlighter/dist/cjs/styles/prism').coldarkDark
  const source = `export { coldarkDark as commonjs } from ${JSON.stringify(commonjs)}; export { default as esm } from ${JSON.stringify(esm)};`
  for (const target of ['web', 'desktop']) {
    const { code } = await compile(source, target)
    const themes = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#syntax-exports-${++sequence}`)
    assert.deepEqual(themes.commonjs, expected)
    assert.deepEqual(themes.esm, expected)
  }
})

test('Vite uses the same existing Lightning CSS color space and neutral mixing as hosted CSS', async () => {
  const filename = resolve(repository, 'app/globals.css')
  const css = await postcss(sharedStylePlugins(repository)).process(await readFile(filename, 'utf8'), { from: filename })
  const declarations = new Map()
  css.root.walkRules(rule => {
    if (rule.selector !== ':root' && rule.selector !== '.dark') return
    for (const node of rule.nodes) if (node.type === 'decl') declarations.set(`${rule.selector}/${node.prop}`, node.value)
  })
  assert.equal(declarations.get(':root/--sidebar-primary'), 'lab(44.0605% 29.0279 -86.0352)')
  assert.equal(declarations.get(':root/--sidebar'), 'lab(98.26% 0 0)')
  assert.equal(declarations.get('.dark/--sidebar-primary'), 'lab(36.9089% 35.0961 -85.6872)')
  assert.equal(declarations.get('.dark/--sidebar'), 'lab(1.3738% 0 0)')
  // Cartesian mixing keeps the primary blue on the neutral sidebar ground.
  assert.match(declarations.get(':root/--sidebar-primary-soft'), /color-mix\(in oklab,\s*var\(--sidebar-primary\)\s*15%,\s*var\(--sidebar\)\)/)
  assert.match(declarations.get('.dark/--sidebar-primary-soft'), /color-mix\(in oklab,\s*var\(--sidebar-primary\)\s*40%,\s*var\(--sidebar\)\)/)
})

test('official namespace consumers cannot silently render an alternate task detail after an export disappears', async t => {
  const { UI_SLOTS, PUBLIC_CONTRACT_SLOTS } = await import('../../../lib/ui-overlay.mjs')
  const dir = await mkdtemp(join(repository, '.hosted-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'slots'))
  for (const name of UI_SLOTS) if (!PUBLIC_CONTRACT_SLOTS.has(name)) await writeFile(join(dir, 'slots', name + '.tsx'), 'export {}')
  const before = process.env.MIKKA_UI_OVERLAY_DIR
  process.env.MIKKA_UI_OVERLAY_DIR = dir
  t.after(() => { if (before === undefined) delete process.env.MIKKA_UI_OVERLAY_DIR; else process.env.MIKKA_UI_OVERLAY_DIR = before })
  const consumer = 'import * as slot from "@ui-slot/task-detail"; export const detail = slot.TaskDetailFrame ?? "alternate"'
  for (const target of ['web', 'desktop']) await assert.rejects(compile(consumer, target), /MISSING_EXPORT|not exported/)
  await writeFile(join(dir, 'slots/task-detail.tsx'), 'export const TaskDetailFrame = "official"')
  for (const target of ['web', 'desktop']) assert.match((await compile(consumer, target)).code, /official/)
})
