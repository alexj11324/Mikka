// Branch-only experiment: production dependencies and compiler policy stay unchanged.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join, relative, resolve } from 'node:path'

function diagnostics(output, root) {
  return output.replace(/\x1b\[[0-9;]*m/g, '').split('\n').flatMap(line => {
    const match = line.match(/^(.+?)\((\d+),(\d+)\): error TS(\d+):/)
    if (match) return [{ file: relative(root, resolve(root, match[1])), line: Number(match[2]), column: Number(match[3]), code: Number(match[4]) }]
    const config = line.match(/^error TS(\d+):/)
    return config ? [{ file: null, code: Number(config[1]) }] : []
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function routeTypesHash(root) {
  const hash = createHash('sha256')
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0')
    }
  }
  visit(join(root, '.next/types'))
  return hash.digest('hex')
}

if (process.argv.includes('--self-test')) {
  assert.deepEqual(diagnostics('src/a.ts(1,2): error TS2322: bad\nerror TS5101: config', '/repo'), [
    { file: 'src/a.ts', line: 1, column: 2, code: 2322 },
    { file: null, code: 5101 },
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
  assert.deepEqual(diagnostics('\u001b[31mprobe.ts(2,3): error TS2339: missing\u001b[0m', '/repo'), [{ file: 'probe.ts', line: 2, column: 3, code: 2339 }])
  console.log('Compiler benchmark diagnostic parser self-checks passed')
  process.exit(0)
}

assert.equal(process.platform, 'linux', 'Run compiler comparisons only in cloud Linux')
assert.ok(process.env.RUNNER_TEMP, 'Expected an isolated GitHub Actions runner')
const root = process.cwd()
const outputDirectory = join(process.env.RUNNER_TEMP, 'compiler-benchmark-results')
mkdirSync(outputDirectory, { recursive: true })
const compilers = [
  { name: 'pinned-tsgo', command: join(root, 'node_modules/.bin/tsgo') },
  { name: 'typescript-stable', command: join(process.env.RUNNER_TEMP, 'compiler-stable/node_modules/.bin/tsc') },
  { name: 'typescript-beta', command: join(process.env.RUNNER_TEMP, 'compiler-beta/node_modules/.bin/tsc') },
  { name: 'tsrs-default', command: join(process.env.RUNNER_TEMP, 'compiler-tsrs/node_modules/.bin/tsrs') },
]
const args = ['--project', join(root, 'tsconfig.json'), '--noEmit', '--incremental', 'false', '--pretty', 'false']
const sourceRouteTypesHash = routeTypesHash(root)
const report = {
  revision: process.env.GITHUB_SHA,
  sourceRevision: 'ca1a9c6d51bbdb9442254a5d9ff6c1c1fb63ec52',
  runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  logicalCpus: cpus().length,
  totalMemoryKiB: Math.round(totalmem() / 1024),
  routeTypesSha256: sourceRouteTypesHash,
  arguments: args,
  runs: [],
  versions: {},
}
for (const compiler of compilers) {
  const version = spawnSync(compiler.command, ['--version'], { encoding: 'utf8', cwd: root })
  assert.equal(version.status, 0, `${compiler.name} version command failed: ${version.stderr}`)
  report.versions[compiler.name] = version.stdout.trim()
}

function check(compiler, phase, iteration) {
  const basename = `${compiler.name}-${phase}-${iteration}`
  const metricsPath = join(outputDirectory, `${basename}.time`)
  const result = spawnSync('/usr/bin/timeout', ['--signal=KILL', '300s', '/usr/bin/time', '-q', '-f', '%e\t%M\t%x', '-o', metricsPath, compiler.command, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 310_000,
    env: { ...process.env, NODE_OPTIONS: '' },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(join(outputDirectory, `${basename}.log`), output)
  assert.ifError(result.error)
  assert.ok(existsSync(metricsPath), `${compiler.name} did not produce resource metrics`)
  const [seconds, peakRssKiB, commandExitCode] = readFileSync(metricsPath, 'utf8').trim().split('\t').map(Number)
  assert.ok([seconds, peakRssKiB, commandExitCode].every(Number.isFinite), `${compiler.name} returned invalid metrics`)
  const row = { compiler: compiler.name, phase, iteration, seconds, peakRssKiB, exitCode: result.status, commandExitCode, diagnostics: diagnostics(output, root) }
  report.runs.push(row)
  writeFileSync(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`${basename}: exit=${row.exitCode}, ${seconds}s, peakRSS=${peakRssKiB}KiB, diagnostics=${row.diagnostics.length}`)
  return row
}

for (const compiler of compilers) check(compiler, 'warmup', 1)
// Rotate the order so every compiler sees early and late positions on one runner.
for (let iteration = 0; iteration < 5; iteration++) {
  for (let offset = 0; offset < compilers.length; offset++) {
    check(compilers[(iteration + offset) % compilers.length], 'baseline', iteration + 1)
  }
}

const probePath = join(root, 'compiler-benchmark-probe.ts')
assert.equal(existsSync(probePath), false, 'The disposable probe must not overwrite a source file')
try {
  writeFileSync(probePath, [
    'export const compilerBenchmarkNumber: number = "not-a-number"',
    'export const compilerBenchmarkProperty = ({ present: true }).absent',
    'export const compilerBenchmarkArgument = ((value: number) => value)("not-a-number")',
    'export function compilerBenchmarkNull(value: string | null) { return value.length }',
    '',
  ].join('\n'))
  report.probes = compilers.map(compiler => {
    const row = check(compiler, 'probe', 1)
    const codes = row.diagnostics.filter(diagnostic => diagnostic.file === 'compiler-benchmark-probe.ts').map(diagnostic => diagnostic.code)
    return { compiler: compiler.name, detectedAll: row.exitCode !== 0 && [2322, 2339, 2345, 18047].every(code => codes.includes(code)), codes }
  })
} finally {
  rmSync(probePath)
}
assert.equal(routeTypesHash(root), sourceRouteTypesHash, 'Compilers must reuse identical generated route types')
report.compatibility = compilers.map(compiler => {
  const runs = report.runs.filter(row => row.compiler === compiler.name && row.phase === 'baseline')
  return { compiler: compiler.name, allChecksPassed: runs.every(row => row.exitCode === 0), diagnosticsStable: runs.every(row => JSON.stringify(row.diagnostics) === JSON.stringify(runs[0].diagnostics)) }
})
report.tsrsBetaParity = ['baseline', 'probe'].every(phase => {
  const beta = report.runs.find(row => row.compiler === 'typescript-beta' && row.phase === phase)
  const tsrs = report.runs.find(row => row.compiler === 'tsrs-default' && row.phase === phase)
  return beta.exitCode === tsrs.exitCode && JSON.stringify(beta.diagnostics) === JSON.stringify(tsrs.diagnostics)
})
writeFileSync(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2))
const summary = ['| Compiler | Checks pass | Error probes | Mean cold seconds | Mean peak RSS MiB |', '| --- | --- | --- | ---: | ---: |']
for (const compiler of compilers) {
  const rows = report.runs.filter(row => row.compiler === compiler.name && row.phase === 'baseline')
  const mean = key => rows.reduce((sum, row) => sum + row[key], 0) / rows.length
  summary.push(`| ${compiler.name} (${report.versions[compiler.name]}) | ${report.compatibility.find(row => row.compiler === compiler.name).allChecksPassed} | ${report.probes.find(row => row.compiler === compiler.name).detectedAll} | ${mean('seconds').toFixed(2)} | ${(mean('peakRssKiB') / 1024).toFixed(1)} |`)
}
summary.push('', `TSRS / TypeScript 7.1 beta diagnostic position + code parity: ${report.tsrsBetaParity}`, '', `Generated route types SHA-256: ${sourceRouteTypesHash}`, '', 'Cold means incremental reuse is disabled; operating-system file caches are shared. Compiler compatibility failures are reported without suppressing diagnostics.')
writeFileSync(join(outputDirectory, 'summary.md'), `${summary.join('\n')}\n`)
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`, { flag: 'a' })
console.log(summary.join('\n'))
