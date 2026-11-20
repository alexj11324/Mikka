import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { tmpdir, cpus } from 'node:os'
import { mock } from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as vite from 'vite'

const require = createRequire(import.meta.url)
const viteRequire = createRequire(require.resolve('vite/package.json'))
const { VERSION } = await import(pathToFileURL(viteRequire.resolve('rolldown')).href)

const root = process.cwd()
const evidence = process.env.PROBE_DIRECTORY
assert.ok(evidence)
await mkdir(evidence, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const captures = []
async function captureBuild(config) {
  const snapshot = { define: config.define, build: config.build, base: config.base }
  const beforeMinify = []
  config.plugins.push({ name: 'frontend-determinism-capture', enforce: 'post',
    renderChunk(code, chunk) { beforeMinify.push({ ...chunk, moduleIds: [...chunk.moduleIds], code, type: 'chunk' }); return null },
  })
  const result = await vite.build(config)
  captures.push({ config: snapshot, beforeMinify, outputs: (Array.isArray(result) ? result : [result]).flatMap(value => value.output ?? []) })
  return result
}
mock.module('vite', { namedExports: { ...vite, build: captureBuild } })
const { buildFrontend } = await import('./build.mjs')
const { frontendConfig } = await import('../vite.config.mjs')
console.log(JSON.stringify({ event: 'probe-environment', node: process.version, vite: vite.version, rolldown: VERSION, cpus: cpus().length }))

function inventory(outputs) {
  return outputs.filter(output => output.fileName.startsWith('assets/')).map(output => ({
    fileName: output.fileName, type: output.type,
    bytes: Buffer.from(output.type === 'chunk' ? output.code : output.source),
    ...(output.type === 'chunk' ? {
      facade: output.facadeModuleId, imports: output.imports, dynamicImports: output.dynamicImports, exports: output.exports,
      modules: output.moduleIds ?? Object.keys(output.modules),
      logical: 'chunk:' + (output.facadeModuleId ?? output.name) + ':' + hash([...(output.moduleIds ?? Object.keys(output.modules))].sort().join('\n')),
    } : { logical: 'asset:' + output.fileName.replace(/-[\w-]{8}(?=\.)/, '-HASH') }),
  }))
}

function normalized(records) {
  const references = records.map(record => [record.fileName, record.logical]).sort((a, b) => b[0].length - a[0].length)
  return records.map(record => {
    let code = record.bytes.toString()
    for (const [name, logical] of references) code = code.replaceAll(name, logical).replaceAll(basename(name), logical)
    return { ...record, normalized: code, sha256: hash(record.bytes), normalizedSha256: hash(code) }
  })
}

async function retain(name, records) {
  for (const record of records) {
    const file = join(evidence, name, record.fileName)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, record.bytes)
  }
  await writeFile(join(evidence, name + '.json'), JSON.stringify(records.map(({ bytes, normalized, ...record }) => record), null, 2))
}

function compare(left, right) {
  const a = normalized(inventory(left)), b = normalized(inventory(right))
  const byKey = new Map(b.map(record => [record.logical, record]))
  const changed = []
  for (const record of a) {
    const other = byKey.get(record.logical)
    if (!other) { changed.push({ kind: 'module-group-missing', file: record.fileName, facade: record.facade, modules: record.modules }); continue }
    byKey.delete(record.logical)
    if (record.normalizedSha256 === other.normalizedSha256) continue
    let index = 0
    while (index < record.normalized.length && record.normalized[index] === other.normalized[index]) index++
    changed.push({ kind: 'normalized-bytes', file: record.fileName, other: other.fileName, facade: record.facade,
      moduleOrderSame: JSON.stringify(record.modules) === JSON.stringify(other.modules),
      a: record.normalized.slice(Math.max(0, index - 100), index + 300), b: other.normalized.slice(Math.max(0, index - 100), index + 300),
      modules: record.modules.filter(id => !id.includes('node_modules')).map(id => relative(root, id)),
    })
  }
  changed.push(...[...byKey.values()].map(record => ({ kind: 'module-group-added', file: record.fileName, modules: record.modules })))
  return { a, b, changed, rawSame: hash(a.map(record => record.sha256).sort().join('')) === hash(b.map(record => record.sha256).sort().join('')) }
}

let drift = false
for (const mode of ['incremental-clean', 'clean-clean', 'direct-clean-clean']) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-determinism-'))
  try {
    if (mode === 'incremental-clean') {
      await mkdir(join(directory, 'assets'))
      await writeFile(join(directory, 'assets/obsolete.js'), 'import "./previous-deployment.js";\n')
    }
    const configs = []
    const run = async clean => {
      if (mode === 'direct-clean-clean') {
        const config = await frontendConfig({ target: 'web', outdir: directory, clean, publicTestFixture: true })
        configs.push({ define: config.define, build: config.build, base: config.base })
        return captureBuild(config)
      }
      return buildFrontend({ target: 'web', outdir: directory, clean, publicTestFixture: true })
    }
    const first = await run(mode !== 'incremental-clean')
    const firstCapture = captures.pop()
    const firstOutputs = firstCapture.outputs
    const second = await run(true)
    const secondCapture = captures.pop()
    const secondOutputs = secondCapture.outputs
    if (mode !== 'direct-clean-clean') configs.push(firstCapture.config, secondCapture.config)
    const result = compare(firstOutputs, secondOutputs)
    const beforeMinify = compare(firstCapture.beforeMinify, secondCapture.beforeMinify)
    const { a, b, ...summary } = result
    console.log(JSON.stringify({ event: 'probe-pair', mode, configsSame: JSON.stringify(configs[0]) === JSON.stringify(configs[1]),
      identitySame: mode === 'direct-clean-clean' ? null : first.rendererBuild === second.rendererBuild, ...summary }))
    console.log(JSON.stringify({ event: 'probe-before-minify', mode, rawSame: beforeMinify.rawSame, changed: beforeMinify.changed }))
    await writeFile(join(evidence, mode + '-summary.json'), JSON.stringify({ mode, configs, ...summary }, null, 2))
    if (!result.rawSame) {
      drift = true
      await retain(mode + '-first', a)
      await retain(mode + '-second', b)
      await retain(mode + '-pre-first', beforeMinify.a)
      await retain(mode + '-pre-second', beforeMinify.b)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
await writeFile(join(evidence, 'result.json'), JSON.stringify({ drift, revision: process.env.GITHUB_SHA }))
if (drift) process.exitCode = 1
