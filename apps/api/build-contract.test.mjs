import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { copyPublicAssets, createNitro, prepare } from 'nitro/builder'
import { assertApiBuildConfiguration } from './build-contract.mjs'
import { publicAssetConfiguration } from './public-assets.mjs'

test('shared tracing loads in a native Node worker without a TypeScript resolver', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e',
    'import { safeErrorAttributes } from "@mikka/protocol/tracing"; if (safeErrorAttributes(new Error("private"))["error.type"] !== "Error") process.exit(1)'],
  { cwd: new URL('../../', import.meta.url), env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe' })
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
    // The real callers derive root from a directory URL, which keeps a
    // trailing slash; the alias table holds the same path without one.
    assertApiBuildConfiguration(nitro, `${root}${sep}`)
    // Dropping the `@` alias must fail: `resolve('')` is the working
    // directory, so a missing key would otherwise compare equal to `root`.
    const withoutAlias = { ...nitro.options, alias: Object.fromEntries(Object.entries(nitro.options.alias ?? {}).filter(([key]) => key !== '@')) }
    assert.throws(() => assertApiBuildConfiguration({ options: withoutAlias }, root), /API_CONFIG_NOT_LOADED/)
    assert.equal(nitro.options.workflow.runtime, 'nodejs24.x')
    assert.equal(nitro.options.preset, 'node-server')
    assert.equal(nitro.options.vercel, undefined)
  } finally { await nitro?.close(); await rm(temporary, { recursive: true, force: true }) }
})
