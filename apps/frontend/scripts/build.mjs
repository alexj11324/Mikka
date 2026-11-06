import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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
  }
  return result
}

export async function buildFrontend({ target = 'web', outdir = resolve(frontend, 'dist', target), clean = true } = {}) {
  const config = await frontendConfig({ target, outdir, clean })
  const built = await build(config)
  const application = config.plugins.find(plugin => plugin.name === 'mikka-shared-application')
  const inventory = application?.api.inventory()
  if (!inventory || inventory.serverModules.length) throw new Error('FRONTEND_INVENTORY_MISSING')
  const fingerprint = createHash('sha256')
  for (const path of (await assetFiles(resolve(outdir, 'assets'))).sort()) {
    fingerprint.update(relative(outdir, path).split(sep).join('/'))
    fingerprint.update(await readFile(path))
  }
  const rendererBuild = fingerprint.digest('hex')
  const result = { ...inventory, rendererBuild }
  await writeFile(resolve(outdir, 'renderer-build.js'), `export const rendererBuild = ${JSON.stringify(rendererBuild)};\n`)
  await writeFile(resolve(outdir, 'renderer-manifest.json'), `${JSON.stringify(result, null, 2)}\n`)
  // Next served this source icon as metadata; retain it in the static build.
  await cp(resolve(repository, 'app/icon.svg'), resolve(outdir, 'icon.svg'))
  if (target === 'desktop') {
    const directory = resolve(repository, 'apps/desktop/dist')
    await mkdir(directory, { recursive: true })
    const outputs = (Array.isArray(built) ? built : [built]).flatMap(value => value.output ?? [])
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
