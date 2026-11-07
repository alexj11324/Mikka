import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../Mikka/node_modules/esbuild/lib/main.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../Mikka')
const path = 'apps/desktop/src/renderer/read-batch.ts'
const beforeRevision = 'ad8d257129989be43a3cb92e48ccd1197a6d096c'
const previous = execFileSync('git', ['show', `${beforeRevision}:${path}`], { cwd: repo, encoding: 'utf8' })
const current = await readFile(resolve(repo, path), 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
async function load(source, id) {
  const built = await build({
    absWorkingDir: repo,
    stdin: { contents: source, loader: 'ts', sourcefile: path, resolveDir: resolve(repo, dirname(path)) },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023',
    tsconfig: resolve(repo, 'apps/frontend/tsconfig.json'),
  })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}#${id}`)
}
const modules = [await load(previous, 'before'), await load(current, 'after')]
const context = { locale: 'en', workspace: 'fixture', currentWorkspace: () => 'fixture' }
const send = async () => true
const durations = [[], []]
const elapsed = async api => {
  const start = performance.now()
  assert.equal(await api.enqueueRead('projects.listProjects', [], context, send), true)
  return performance.now() - start
}
for (let index = 0; index < 50; index++) for (const api of modules) await elapsed(api)
for (let pair = 0; pair < 500; pair++) {
  for (const index of pair % 2 ? [1, 0] : [0, 1]) durations[index].push(await elapsed(modules[index]))
}
const stats = samples => {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    count: samples.length,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50: sorted[Math.ceil(samples.length * 0.5) - 1],
    p95: sorted[Math.ceil(samples.length * 0.95) - 1],
    p99: sorted[Math.ceil(samples.length * 0.99) - 1],
    max: sorted.at(-1),
  }
}
const receipt = {
  version: 1, kind: 'native_read_wave_scheduling_benchmark', recordedAt: new Date().toISOString(),
  scope: 'Node 24 offline execution of the actual bundled renderer read queue; one allowed read, no HTTP/DB/UI/rendering; paired alternating order',
  productionAcceptance: false,
  source: { path, beforeRevision, beforeSha256: hash(previous), afterSha256: hash(current) },
  unit: 'milliseconds', warmupEach: 50,
  before: stats(durations[0]), after: stats(durations[1]),
  pairedAdded: stats(durations[1].map((value, index) => value - durations[0][index])),
  externalRequests: 0, databaseQueries: 0, modelCalls: 0,
  resources: 'Each MessageChannel closes both ports before invoking the real flush; process termination is the final leak check.',
  rawPairedDurations: durations[0].map((value, index) => [value, durations[1][index]]),
}
await writeFile(resolve(here, 'evidence/native-read-wave-benchmark.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ before: receipt.before, after: receipt.after, pairedAdded: receipt.pairedAdded }))
