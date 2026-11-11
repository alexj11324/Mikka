import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { copyPublicAssets, createNitro, prepare } from 'nitro/builder'
import { assertApiBuildConfiguration, nodeRuntimePackages, routeFunctionRules, workflowNodeExternals } from './build-contract.mjs'
import { publicAssetConfiguration } from './public-assets.mjs'
import { inspectRoute } from './scripts/generate-routes.mjs'

// Use the exact router Nitro uses when it sorts and emits Vercel function
// rules. Source-shape assertions alone missed its multiple-wildcard failure.
const nitroRequire = createRequire(import.meta.resolve('nitro/package.json'))
const { addRoute, createRouter, findRoute, routeToRegExp } = await import(pathToFileURL(nitroRequire.resolve('rou3')).href)

test('shared tracing loads in a native Node worker without a TypeScript resolver', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e',
    'import { safeErrorAttributes } from "@mikka/protocol/tracing"; if (safeErrorAttributes(new Error("private"))["error.type"] !== "Error") process.exit(1)'],
  { cwd: new URL('../../', import.meta.url), env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' })
})

test('declaration inventory includes named reexports/destructuring and preserves explicit duration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-route-source-'))
  try {
    await writeFile(join(root, 'handler.ts'), 'export const maxDuration = 120; export const {GET, POST} = handlers; throw new Error("must never evaluate")')
    await writeFile(join(root, 'route.ts'), 'export { GET as HEAD, POST, maxDuration } from "./handler"; export async function OPTIONS() {}')
    const result = await inspectRoute(root, 'route.ts')
    assert.deepEqual(result.methods, ['HEAD', 'OPTIONS', 'POST']); assert.equal(result.maxDuration, 120)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('function rules remain per route, source-bound, and accept actual catch-all names without traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-route-contract-'))
  try {
    const source = 'app/api/[...all]/route.ts', text = 'export const maxDuration=60; export const GET=handler'
    await mkdir(join(root, 'app/api/[...all]'), { recursive: true }); await writeFile(join(root, source), text)
    await mkdir(join(root, 'apps/api/generated'), { recursive: true })
    const route = { source, path: '/mikka/api/[...all]', template: '/api/[...all]', methods: ['GET'], maxDuration: 60, sourceHash: createHash('sha256').update(text).digest('hex') }
    const save = value => writeFile(join(root, 'apps/api/generated/routes.json'), JSON.stringify({ version: 1, basePath: '/mikka', routes: [value] }))
    await save(route); assert.deepEqual(await routeFunctionRules(root), { '/mikka/api/**': { maxDuration: 60 } })
    await save({ ...route, source: 'app/../outside.ts' }); await assert.rejects(routeFunctionRules(root), /API_ROUTE_MANIFEST_INVALID/)
    await save({ ...route, sourceHash: '0'.repeat(64) }); await assert.rejects(routeFunctionRules(root), /API_ROUTE_SOURCE_CHANGED/)
    const nitro = { options: { externals: { external: ['existing'] } } }; workflowNodeExternals(nitro)
    assert.deepEqual(nitro.options.externals.external, ['existing', ...nodeRuntimePackages])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('actual Nitro router accepts multiple named parameters and preserves route duration boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-vercel-routing-'))
  try {
    const declarations = [
      ['/api/bots/[botId]/subagents/[id]/credentials', 60],
      ['/v1/devices/[deviceId]/runs/[runId]/subscription', 300],
      ['/api/agents/[...path]', 300],
    ]
    const routes = []
    for (const [template, maxDuration] of declarations) {
      const source = `app${template}/route.ts`, text = `export const maxDuration=${maxDuration}; export const POST=handler`
      await mkdir(join(root, `app${template}`), { recursive: true })
      await writeFile(join(root, source), text)
      routes.push({ template, path: `/mikka${template}`, source, methods: ['POST'], maxDuration,
        sourceHash: createHash('sha256').update(text).digest('hex') })
    }
    await mkdir(join(root, 'apps/api/generated'), { recursive: true })
    await writeFile(join(root, 'apps/api/generated/routes.json'), JSON.stringify({ version: 1, basePath: '/mikka', routes }))
    const rules = await routeFunctionRules(root), router = createRouter()
    for (const [path, data] of Object.entries(rules)) addRoute(router, '', path, data)
    const credentials = '/mikka/api/bots/:botId/subagents/:id/credentials'
    assert.deepEqual(rules[credentials], { maxDuration: 60 })
    const matched = findRoute(router, '', '/mikka/api/bots/bot-1/subagents/agent-1/credentials')
    assert.deepEqual(matched?.data, { maxDuration: 60 })
    assert.deepEqual({ ...matched?.params }, { botId: 'bot-1', id: 'agent-1' })
    assert.equal(findRoute(router, '', '/mikka/v1/devices/device-1/runs/run-1/subscription')?.data.maxDuration, 300)
    assert.deepEqual(findRoute(router, '', '/mikka/api/agents/eve/v1/session')?.data, { maxDuration: 300, supportsCancellation: true })
    const pattern = routeToRegExp(credentials)
    for (const path of ['/mikka/api/bots/subagents/agent-1/credentials', '/mikka/api/bots/bot-1/extra/subagents/agent-1/credentials',
      '/mikka/api/bots/bot-1/subagents/agent-1/credentials/extra', '/mikka/api/bots/bot-1/subagents/agent-1/other']) {
      assert.equal(pattern.test(path), false, path)
      assert.equal(findRoute(router, '', path), undefined, path)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('actual Nitro Vercel output opts MCP into cancellation without changing other functions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-mcp-cancellation-'))
  let nitro
  try {
    const declarations = [['/api/mcp', 120], ['/api/agents/[...path]', 300], ['/api/other', 60]]
    const routes = []
    for (const [template, maxDuration] of declarations) {
      const source = `app${template}/route.ts`, text = `export const maxDuration=${maxDuration}; export const POST=handler`
      await mkdir(join(root, `app${template}`), { recursive: true })
      await writeFile(join(root, source), text)
      routes.push({ template, path: `/mikka${template}`, source, methods: ['POST'], maxDuration,
        sourceHash: createHash('sha256').update(text).digest('hex') })
    }
    await mkdir(join(root, 'apps/api/generated'), { recursive: true })
    await writeFile(join(root, 'apps/api/generated/routes.json'), JSON.stringify({ version: 1, basePath: '/mikka', routes }))
    nitro = await createNitro({ rootDir: root, workspaceDir: root, serverDir: false, preset: 'vercel',
      vercel: { functions: { runtime: 'nodejs24.x' }, functionRules: await routeFunctionRules(root) },
    }, { dotenv: false })
    await prepare(nitro)
    await writeFile(join(nitro.options.output.serverDir, 'index.mjs'), 'export default () => new Response("fixture")')
    // Exercise the installed preset's real config emitter, without compiling
    // or invoking an application, fetching credentials, or deploying anything.
    await nitro.hooks.callHook('compiled', nitro)
    const readConfig = async path => JSON.parse(await readFile(join(nitro.options.output.dir, `functions/${path}.func/.vc-config.json`), 'utf8'))
    const mcp = await readConfig('mikka/api/mcp')
    assert.equal(mcp.supportsCancellation, true, 'MCP_HTTP_CANCELLATION_NOT_ENABLED')
    assert.equal(mcp.maxDuration, 120)
    assert.equal(mcp.supportsResponseStreaming, true)
    assert.equal(mcp.runtime, 'nodejs24.x')
    assert.equal((await readConfig('mikka/api/agents/[...]')).supportsCancellation, true)
    assert.equal((await readConfig('mikka/api/other')).supportsCancellation, undefined)
    assert.equal((await readConfig('__server')).supportsCancellation, undefined)
  } finally { await nitro?.close(); await rm(root, { recursive: true, force: true }) }
})

test('actual Nitro copy excludes SPA index and internal metadata without exposing root/public', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-public-assets-'))
  let nitro
  try {
    const web = join(root, 'apps/frontend/dist/web')
    await mkdir(join(web, 'assets'), { recursive: true }); await mkdir(join(web, '.vite'))
    await mkdir(join(root, 'public'))
    for (const [path, value] of [['index.html', '<html>private shell</html>'], ['assets/app-HASH.js', 'export{}'], ['renderer-manifest.json', '{}'], ['logo.svg', '<svg/>'], ['.vite/manifest.json', '{}']]) await writeFile(join(web, path), value)
    await writeFile(join(root, 'public/root-only.txt'), 'must not appear at root')
    const assets = await publicAssetConfiguration(root)
    nitro = await createNitro({ rootDir: root, workspaceDir: root, serverDir: false, preset: 'node-server', ...assets }, { dotenv: false })
    await prepare(nitro); await copyPublicAssets(nitro)
    const output = join(nitro.options.output.publicDir, 'mikka')
    assert.deepEqual((await readdir(output)).sort(), ['assets', 'logo.svg', 'renderer-manifest.json'])
    assert.equal(await readFile(join(output, 'assets/app-HASH.js'), 'utf8'), 'export{}')
    assert.deepEqual(await readdir(nitro.options.output.publicDir), ['mikka'])
    assert.equal(assets.routeRules['/mikka/renderer-manifest.json'].headers['cache-control'], 'public, max-age=0, must-revalidate')
    assert.equal(assets.routeRules['/mikka/assets/**'].headers['x-content-type-options'], 'nosniff')
  } finally { await nitro?.close(); await rm(root, { recursive: true, force: true }) }
})

test('actual root Nitro configuration loads the API/Workflow graph; an empty default graph is rejected', async () => {
  assert.throws(() => assertApiBuildConfiguration({ options: { routes: {}, alias: {} } }, process.cwd()), /API_CONFIG_NOT_LOADED/)
  const root = process.cwd(), temporary = await mkdtemp(join(tmpdir(), 'mikka-config-proof-'))
  let nitro
  try {
    nitro = await createNitro({ rootDir: root, preset: 'node-server', buildDir: join(temporary, 'build'), output: { dir: join(temporary, 'output') } }, { dotenv: false })
    assertApiBuildConfiguration(nitro, root)
    assert.equal(nitro.options.workflow.runtime, 'nodejs24.x')
    assert.equal(nitro.options.vercel.functionRules['/mikka/api/agents/**'].supportsCancellation, true)
  } finally { await nitro?.close(); await rm(temporary, { recursive: true, force: true }) }
})
