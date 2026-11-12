import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { frontendConfig } from '../vite.config.mjs'
import { frontend, repository } from './application-plugin.mjs'

async function assetFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await assetFiles(path))
    else if (entry.isFile()) result.push(path)
    else throw new Error(`FRONTEND_ASSET_NOT_REGULAR: ${entry.name}`)
  }
  return result
}

export async function buildFrontend({ target = 'web', outdir = resolve(frontend, 'dist', target), clean = true } = {}) {
  const config = await frontendConfig({ target, outdir, clean })
  outdir = resolve(config.root, config.build.outDir)
  // This directory belongs to the build. Complete its removal before Vite
  // writes anything, then verify the emitted inventory before publishing it.
  if (clean) await rm(outdir, { recursive: true, force: true })
  const built = await build(config)
  const application = config.plugins.find(plugin => plugin.name === 'mikka-shared-application')
  const inventory = application?.api.inventory()
  if (!inventory || inventory.serverModules.length) throw new Error('FRONTEND_INVENTORY_MISSING')
  const outputs = (Array.isArray(built) ? built : [built]).flatMap(value => value.output ?? [])
  const assets = new Map(outputs.filter(value => value.fileName.startsWith('assets/')).map(value => [value.fileName, value]))
  for (const path of await assetFiles(resolve(outdir, 'assets'))) {
    const name = relative(outdir, path).split(sep).join('/')
    if (clean && !assets.has(name)) throw new Error(`FRONTEND_ASSET_UNEXPECTED: ${name}`)
  }
  const fingerprint = createHash('sha256')
  // Incremental desktop development retains old chunks for existing windows,
  // but only this build's emitted assets identify the current application.
  for (const name of [...assets.keys()].sort()) {
    const asset = assets.get(name)
    const content = await readFile(resolve(outdir, name))
    const emitted = Buffer.from(asset.type === 'chunk' ? asset.code : asset.source)
    if (!content.equals(emitted)) throw new Error(`FRONTEND_ASSET_CONTENT_MISMATCH: ${name}`)
    fingerprint.update(name)
    fingerprint.update(content)
  }
  const rendererBuild = fingerprint.digest('hex')
  const result = { ...inventory, rendererBuild }
  await writeFile(resolve(outdir, 'renderer-build.js'), `export const rendererBuild = ${JSON.stringify(rendererBuild)};\n`)
  await writeFile(resolve(outdir, 'renderer-manifest.json'), `${JSON.stringify(result, null, 2)}\n`)
  if (target === 'desktop') {
    const directory = resolve(repository, 'apps/desktop/dist')
    await mkdir(directory, { recursive: true })
    const graph = { format: 'vite-rolldown', inputs: inventory.inputs, outputs: outputs.map(value => value.type === 'chunk'
      ? { fileName: value.fileName, type: value.type, isEntry: value.isEntry, imports: value.imports, dynamicImports: value.dynamicImports, modules: Object.keys(value.modules) }
      : { fileName: value.fileName, type: value.type }) }
    await writeFile(resolve(directory, 'renderer-metafile.json'), `${JSON.stringify(graph)}\n`)
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv.includes('--desktop') ? 'desktop' : 'web'
  const result = await buildFrontend({ target })
  process.stdout.write(`${JSON.stringify({ target, rendererBuild: result.rendererBuild, actions: result.usedActions.length, exports: result.exports, serverModules: result.serverModules })}\n`)
}
