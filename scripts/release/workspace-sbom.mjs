import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/** Inventory the selected installed production graph, not unrelated workspace/dev dependencies. */
export async function workspaceSbom(trees, { sourceSha, bundledEntries = [], readManifest = async path => JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? '') || !Array.isArray(trees) || trees.length !== 1) throw Error('releaseSbomInputInvalid')
  const components = new Map(), edges = new Map(), visited = new Set()
  async function visit(node) {
    const manifest = await readManifest(node.path)
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw Error('releaseSbomPackageInvalid')
    const ref = `pkg:npm/${manifest.name.replace(/^@/, '%40')}@${encodeURIComponent(manifest.version)}`
    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type
    components.set(ref, { type: 'library', 'bom-ref': ref, name: manifest.name, version: manifest.version, purl: ref,
      ...(license ? { licenses: [{ license: { name: license } }] } : {}) })
    edges.set(ref, edges.get(ref) ?? new Set())
    if (!visited.has(node)) {
      visited.add(node)
      const children = { ...node.dependencies, ...node.optionalDependencies }
      if (node === trees[0]) for (const name of bundledEntries) {
        const child = children[name] ?? node.devDependencies?.[name]
        if (!child) throw Error('releaseBundledDependencyMissing')
        children[name] = child
      }
      for (const child of Object.values(children)) edges.get(ref).add(await visit(child))
    }
    return ref
  }
  const root = await visit(trees[0]), component = components.get(root)
  return { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
    serialNumber: `urn:uuid:${randomUUID()}`,
    metadata: { component, properties: [{ name: 'mikka:source-sha', value: sourceSha }] },
    components: [...components.values()].filter(value => value['bom-ref'] !== root).sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])),
    dependencies: [...edges].map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() })).sort((a, b) => a.ref.localeCompare(b.ref)) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) throw Error('releaseSbomFilesRequired')
  const bom = await workspaceSbom(JSON.parse(await readFile(input, 'utf8')), { sourceSha: process.env.GITHUB_SHA, bundledEntries: ['electron', 'electron-updater', '@mikka/daemon', '@mikka/protocol'] })
  await writeFile(output, JSON.stringify(bom, null, 2) + '\n')
  console.log(JSON.stringify({ sourceSha: process.env.GITHUB_SHA, components: bom.components.length }))
}
