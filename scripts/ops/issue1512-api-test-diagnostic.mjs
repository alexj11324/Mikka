import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORD_PREFIX, isProjectedRecord } from './issue1512-api-test-reporter.mjs'

const SOURCE = '817480a70ada3b66fca2cf55e9cf7b0d5e2d350a'
const TREE = 'b907cf48fc48c82351fe2e141970fbf77bc12ed8'
const ALIAS = 'apps/api/scripts/workflow-development-aliases.test.mjs'
const ORIGINAL_ALIAS = '1db8226a7a15d47e385d971c0f59fea93bd22677dcd1752c9a502b52743abefd'
const PATCHED_ALIAS = 'f852fba6f783343bf4983b74af77cc1a1260a9dacf854147083828b5c601de2c'
const PACKAGE_HASH = '5cf0c81d21ff3a8ebba68c7174486a37fb509446781403fcc00c4941f218f49a'
const PATCH_HASH = 'b4c3086f59a63e533e3dd3bf484284a9272f0511cce6f8fcf1921857d3c7f2ec'
const REPORTER_HASH = '3de38bf0d47d5f18001814a321ce05573d5234c65940bdb9294085446fc431ad'
const SHA = value => createHash('sha256').update(value).digest('hex')
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const opsRoot = resolve(scriptDirectory, '../..')
const signals = new Set(['SIGABRT','SIGBUS','SIGFPE','SIGILL','SIGINT','SIGKILL','SIGQUIT','SIGSEGV','SIGTERM','SIGTRAP'])
const report = {
  schemaVersion: 1, kind: 'issue1512-owned-api-process-diagnostic',
  status: 'preflight', source: SOURCE, tree: TREE, originalRun: 42399391020,
  originalJob: 128483737003, opsSha: null, runId: null, attempt: null,
  diagnosticOnly: true, productionAcceptance: false, providerCallsRequested: false,
  environment: { node: process.versions.node, processVersion: process.version, pnpm: null, runner: 'ubuntu-22.04',
    testEnvironment: 'the same public static fixture values as the fixed Source checks job' },
  sourceHashes: { originalAlias: ORIGINAL_ALIAS, patchedAlias: PATCHED_ALIAS,
    package: PACKAGE_HASH, phasePatch: PATCH_HASH, reporter: REPORTER_HASH },
  originalTestCommandSha256: null, diagnosticTestCommandSha256: null,
  prechecks: [], test: null, records: [], projection: { invalid: 0, overLimit: 0, incompleteTail: 0 },
  cgroupBefore: null, cgroupAfter: null, cleanup: { sourceRestored: false, packageRestored: false, launcherClosed: false },
  limitations: [
    'Temporary diagnostic checkout only; no candidate source or refs are updated.',
    'All original test groups, assertions, per-test timeouts and default concurrency remain.',
    'A new passing diagnostic run would not itself explain the original failures.',
    'Cgroup counters cover the runner cgroup, not uniquely the alias test process.',
    'Only fixed metadata is retained; raw child stdout/stderr is discarded in bounded memory.',
  ],
}
let active = null, interrupted = false, forceTimer = null
function signalGroup(child, signal) {
  if (!child || active !== child || !Number.isSafeInteger(child.pid) || child.pid <= 1) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') report.cleanup.signalError = true }
}
function interrupt() {
  interrupted = true
  const child = active
  signalGroup(child, 'SIGTERM')
  forceTimer = setTimeout(() => { if (active === child) signalGroup(child, 'SIGKILL') }, 1500)
  forceTimer.unref()
}
process.once('SIGTERM', interrupt)
process.once('SIGINT', interrupt)
function fail(code) { const error = new Error(code); error.diagnosticCode = code; throw error }
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], maxBuffer: 1024 * 1024 }).trim() }
function shellArg(value) { return "'" + value.replaceAll("'", "'\"'\"'") + "'" }
function childEnvironment(source) {
  const env = { ...process.env, MIKKA_I1512_DIAGNOSTIC_SOURCE: source }
  for (const key of ['GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN','ACTIONS_ID_TOKEN_REQUEST_URL']) delete env[key]
  return env
}
function consumeLine(line) {
  if (!line.startsWith(RECORD_PREFIX)) return
  try {
    const value = JSON.parse(line.slice(RECORD_PREFIX.length))
    if (!isProjectedRecord(value)) { report.projection.invalid++; return }
    if (report.records.length >= 512) { report.projection.overLimit++; return }
    report.records.push(value)
    if (['invalid_summary','invalid_phase','alias_diagnostic_oversize'].includes(value.kind)) report.projection.invalid++
  } catch { report.projection.invalid++ }
}
async function runStep(source, label, command, args, capture = false) {
  const started = performance.now()
  const result = { label, exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0, durationMs: null, launcherError: false }
  const tails = { stdout: '', stderr: '' }, discarding = { stdout: false, stderr: false }
  const feed = (name, bytes) => {
    result[name + 'Bytes'] += bytes.length
    if (!capture) return
    const input = tails[name] + bytes.toString('utf8')
    const lines = input.split('\n')
    tails[name] = lines.pop()
    for (const line of lines) {
      if (discarding[name]) { discarding[name] = false; continue }
      if (line.length <= 16384) consumeLine(line.replace(/\r$/, ''))
      else if (line.startsWith(RECORD_PREFIX)) report.projection.overLimit++
    }
    if (tails[name].length > 16384) {
      if (tails[name].startsWith(RECORD_PREFIX)) report.projection.overLimit++
      tails[name] = ''; discarding[name] = true
    }
  }
  await new Promise(resolvePromise => {
    const child = spawn(command, args, { cwd: source, env: childEnvironment(source),
      stdio: ['ignore','pipe','pipe'], detached: true })
    active = child
    child.stdout.on('data', bytes => feed('stdout', bytes))
    child.stderr.on('data', bytes => feed('stderr', bytes))
    child.on('error', () => { result.launcherError = true })
    child.once('close', (code, signal) => {
      result.exitCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null
      result.signal = signals.has(signal) ? signal : null
      if (active === child) active = null
      if (forceTimer) { clearTimeout(forceTimer); forceTimer = null }
      resolvePromise()
    })
  })
  if (capture) for (const tail of Object.values(tails))
    if (tail.startsWith(RECORD_PREFIX)) report.projection.incompleteTail++
  result.durationMs = Math.round((performance.now() - started) * 1000) / 1000
  return result
}
async function cgroupSnapshot() {
  const read = async path => {
    try { const value = await readFile(path, 'utf8'); return value.length <= 4096 ? value.trim() : null } catch { return null }
  }
  const eventsText = await read('/sys/fs/cgroup/memory.events')
  const events = {}
  const keys = new Set(['low','high','max','oom','oom_kill','oom_group_kill','sock_throttled'])
  for (const line of (eventsText ?? '').split('\n')) {
    const match = line.match(/^([a-z_]+) ([0-9]+)$/)
    if (match && keys.has(match[1]) && Number.isSafeInteger(Number(match[2]))) events[match[1]] = Number(match[2])
  }
  const numeric = async path => {
    const value = await read(path)
    return value === 'max' ? 'max' : value !== null && /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
  }
  return { available: eventsText !== null, memoryEvents: events,
    currentBytes: await numeric('/sys/fs/cgroup/memory.current'),
    peakBytes: await numeric('/sys/fs/cgroup/memory.peak'), limitBytes: await numeric('/sys/fs/cgroup/memory.max') }
}
async function restore(path, original, expected) {
  if (!original) return false
  const current = await readFile(path)
  if (SHA(current) === SHA(original)) return true
  if (SHA(current) !== expected) return false
  await writeFile(path, original)
  return SHA(await readFile(path)) === SHA(original)
}
async function main() {
  process.umask(0o077)
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--output') fail('ARGUMENT_CONTRACT')
  const source = resolve(args[1]), output = resolve(args[3])
  const workspace = resolve(process.env.GITHUB_WORKSPACE ?? '')
  if (source !== join(workspace, 'source') || output !== join(workspace, 'evidence/api-test-diagnostic.json') || opsRoot !== join(workspace, 'ops')) fail('PATH_CONTRACT')
  const aliasPath = join(source, ALIAS), packagePath = join(source, 'package.json')
  let originalAlias, originalPackage, modifiedPackageHash
  try {
    if (process.version !== 'v24.22.2' || process.env.GITHUB_RUN_ATTEMPT !== '1') fail('RUNTIME_OR_ATTEMPT')
    if (!/^[0-9]+$/.test(process.env.GITHUB_RUN_ID ?? '')) fail('RUN_ID')
    report.runId = process.env.GITHUB_RUN_ID; report.attempt = 1
    report.opsSha = git(opsRoot, ['rev-parse','HEAD'])
    if (report.opsSha !== process.env.GITHUB_SHA || !/^[a-f0-9]{40}$/.test(report.opsSha)) fail('OPS_SOURCE')
    if (git(source, ['rev-parse','HEAD']) !== SOURCE || git(source, ['rev-parse','HEAD^{tree}']) !== TREE) fail('SOURCE_TREE')
    const pnpm = execFileSync('pnpm', ['--version'], { cwd: source, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim()
    if (pnpm !== '10.34.3') fail('PNPM_VERSION')
    report.environment.pnpm = pnpm
    originalAlias = await readFile(aliasPath); originalPackage = await readFile(packagePath)
    if (SHA(originalAlias) !== ORIGINAL_ALIAS || SHA(originalPackage) !== PACKAGE_HASH) fail('INPUT_HASH')
    const reporterPath = join(scriptDirectory, 'issue1512-api-test-reporter.mjs')
    const patchPath = join(scriptDirectory, 'issue1512-api-test-phases.patch')
    if (SHA(await readFile(reporterPath)) !== REPORTER_HASH || SHA(await readFile(patchPath)) !== PATCH_HASH) fail('DIAGNOSTIC_HASH')
    for (const [label, command, arguments_] of [
      ['lint_code','pnpm',['lint:code']],
      ['route_check','node',['apps/api/scripts/generate-routes.mjs','--check']],
      ['lint_runtime','pnpm',['lint:runtime']],
    ]) {
      if (interrupted) fail('INTERRUPTED')
      report.prechecks.push(await runStep(source, label, command, arguments_))
    }
    if (interrupted) fail('INTERRUPTED')
    git(source, ['apply','--check',patchPath]); git(source, ['apply',patchPath])
    if (SHA(await readFile(aliasPath)) !== PATCHED_ALIAS) fail('PATCH_RESULT_HASH')
    const packageObject = JSON.parse(originalPackage.toString('utf8'))
    const originalCommand = packageObject.scripts?.['test:api']
    const groups = typeof originalCommand === 'string' ? originalCommand.split(' && ') : []
    if (groups.length !== 2 || groups.some(group => !group.startsWith('node ') || !group.includes(' --test ') || group.includes('--test-reporter'))) fail('TEST_COMMAND_CONTRACT')
    report.originalTestCommandSha256 = SHA(originalCommand)
    packageObject.scripts['test:api'] = groups.map(group => group.replace(/^node /, 'node --test-reporter=' + shellArg(reporterPath) + ' ')).join(' && ')
    report.diagnosticTestCommandSha256 = SHA(packageObject.scripts['test:api'])
    const modifiedPackage = JSON.stringify(packageObject, null, 2) + '\n'
    modifiedPackageHash = SHA(modifiedPackage)
    await writeFile(packagePath, modifiedPackage)
    report.cgroupBefore = await cgroupSnapshot()
    report.test = await runStep(source, 'test_api', 'pnpm', ['test:api'], true)
    report.cgroupAfter = await cgroupSnapshot()
    const aggregates = report.records.filter(record => record.kind === 'summary' && record.aggregate)
    const projectionComplete = Object.values(report.projection).every(value => value === 0)
    if (interrupted) report.status = 'interrupted'
    else if (report.test.exitCode !== 0 || report.test.signal || report.test.launcherError) report.status = 'test_failed'
    else if (!projectionComplete || aggregates.length !== 2 || aggregates.some(record => !record.success)) report.status = 'diagnostic_incomplete'
    else if (report.prechecks.some(step => step.exitCode !== 0 || step.signal || step.launcherError)) report.status = 'precheck_failed'
    else report.status = 'passed'
  } catch (error) {
    report.status = 'diagnostic_failed'
    const known = new Set(['RUNTIME_OR_ATTEMPT','RUN_ID','OPS_SOURCE','SOURCE_TREE','PNPM_VERSION','INPUT_HASH','DIAGNOSTIC_HASH','INTERRUPTED','PATCH_RESULT_HASH','TEST_COMMAND_CONTRACT'])
    report.errorCode = known.has(error.diagnosticCode) ? error.diagnosticCode : 'UNEXPECTED_FAILURE'
  } finally {
    try { report.cleanup.sourceRestored = await restore(aliasPath, originalAlias, PATCHED_ALIAS) } catch { report.cleanup.sourceRestored = false }
    try { report.cleanup.packageRestored = await restore(packagePath, originalPackage, modifiedPackageHash) } catch { report.cleanup.packageRestored = false }
    report.cleanup.launcherClosed = active === null
    if (!report.cleanup.sourceRestored || !report.cleanup.packageRestored || !report.cleanup.launcherClosed) report.status = 'cleanup_incomplete'
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    const text = JSON.stringify(report, null, 2) + '\n'
    if (Buffer.byteLength(text) > 256 * 1024) fail('REPORT_SIZE')
    await writeFile(output, text, { mode: 0o600 })
  }
  process.exitCode = report.status === 'passed' ? 0 : 1
  console.log(JSON.stringify({ kind: report.kind, status: report.status, records: report.records.length, cleanup: report.cleanup }))
}
main().catch(() => { console.error('MIKKA_API_DIAGNOSTIC_FAILED'); process.exitCode = 1 })
