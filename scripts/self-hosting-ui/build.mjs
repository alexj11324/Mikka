import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { frontendConfig } from '../../apps/frontend/vite.config.mjs'

const { build } = await import(createRequire(new URL('../../apps/frontend/package.json', import.meta.url)).resolve('vite'))
const repository = fileURLToPath(new URL('../..', import.meta.url))
const directory = resolve(repository, '.artifacts/self-hosting-ui')
const config = await frontendConfig({ target: 'web', outdir: resolve(directory, 'web') })
config.root = fileURLToPath(new URL('.', import.meta.url))
config.build.rolldownOptions.input = resolve(config.root, 'index.html')
await build(config)
const inventory = config.plugins.find(plugin => plugin.name === 'mikka-shared-application').api.inventory()
if (!inventory || inventory.serverModules.length) throw new Error('VISUAL_FRONTEND_INVENTORY_INVALID')
const assets = []
for (const name of (await readdir(resolve(directory, 'web/assets'))).sort()) {
  const bytes = await readFile(resolve(directory, 'web/assets', name))
  assets.push({ file: `assets/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
await mkdir(resolve(directory, 'evidence'), { recursive: true })
await writeFile(resolve(directory, 'evidence/build.json'), `${JSON.stringify({
  kind: 'production-component-composition', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  lockfileSha256: createHash('sha256').update(await readFile(resolve(repository, 'pnpm-lock.yaml'))).digest('hex'),
  inputs: inventory.inputs, serverModules: inventory.serverModules, assets,
}, null, 2)}\n`)
console.log(`Built the existing settings components with ${assets.length} production assets.`)
