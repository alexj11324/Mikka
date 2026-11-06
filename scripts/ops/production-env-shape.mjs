// One-time read-only diagnosis of the production environment handoff.
// Never builds, migrates, deploys, connects to Postgres or emits environment values.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEnvironment, buildEnvironmentValues, REQUIRED } from '../release/web-deploy.mjs'
import { productionBuildEnvironment } from '../release/build-vercel.mjs'
import { directDatabaseURL } from '../postgres-connection.mjs'

const APPLICATION = 'ce512e77f01589f56729c31d00750c0203e46ed9'
const OLD_APPLICATION = '62281b1995cb8fef16e7604dc1ea9a29c4dbbe32'
const REPOSITORY = 'alexj11324/Mikka'
const REF = 'refs/heads/ops/issue1415-production-env-shape'
const TARGETS = ['MIKKA_DATABASE_URL', 'DATABASE_URL']
const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(SELF, '../../..')
const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
const TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const CODES = new Set(['context_refused', 'source_refused', 'main_read_failed', 'main_changed',
  'dependency_version', 'pull_failed', 'pulled_file_refused', 'target_lines_refused',
  'legacy_failed', 'report_exists', 'secret_missing', 'diagnostic_failed'])
const fail = code => { throw new Error(code) }
const code = error => CODES.has(error?.message) ? error.message : 'diagnostic_failed'
const directCodes = new Set(['DATABASE_CONNECTION_URL_INVALID', 'NEON_ENDPOINT_HOST_INVALID',
  'NEON_CONNECTION_OVERRIDE_REFUSED'])

export function shape(value) {
  const type = value === undefined ? 'undefined' : value === null ? 'null' : typeof value
  let url
  if (typeof value === 'string') { try { url = new URL(value) } catch {} }
  let directAccepted = false, directCode = 'not_present'
  if (typeof value === 'string' && value.length) {
    try { directDatabaseURL(value); directAccepted = true; directCode = null }
    catch (error) { directCode = directCodes.has(error?.message) ? error.message : 'other' }
  }
  const host = url?.hostname ?? ''
  return {
    present: value !== undefined, type: ['undefined', 'null', 'string', 'number', 'boolean'].includes(type) ? type : 'other',
    length: typeof value === 'string' ? value.length : null,
    urlParse: Boolean(url), protocol: !url ? null : ['postgres:', 'postgresql:', 'http:', 'https:'].includes(url.protocol) ? url.protocol.slice(0, -1) : 'other',
    hostnameCategory: !url ? 'unparseable' : !host ? 'none' : host.endsWith('.neon.tech') ? 'neon'
      : ['localhost', '127.0.0.1', '[::1]'].includes(host) ? 'loopback' : 'other',
    startsDoubleQuote: typeof value === 'string' && value.startsWith('"'),
    endsDoubleQuote: typeof value === 'string' && value.endsWith('"'),
    startsSingleQuote: typeof value === 'string' && value.startsWith("'"),
    endsSingleQuote: typeof value === 'string' && value.endsWith("'"),
    hasLF: typeof value === 'string' && value.includes('\n'),
    hasCR: typeof value === 'string' && value.includes('\r'),
    hasControlByte: typeof value === 'string' && /[\u0000-\u001f\u007f]/.test(value),
    hasDollarReference: typeof value === 'string' && /\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/.test(value),
    directAccepted, directCode,
  }
}

// Lexical projection of the unchanged private parser in release/web-deploy.mjs.
// Actual fill and direct-build stages below call that module's real public APIs.
function targetInput(text) {
  const result = {}
  for (const key of TARGETS) {
    const matches = text.split('\n').filter(line => line.startsWith(key + '='))
    if (matches.length > 1) fail('target_lines_refused')
    const raw = matches.length ? matches[0].slice(key.length + 1).trim() : undefined
    let decoded = raw
    if (typeof raw === 'string' && raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      try { decoded = JSON.parse(raw) } catch { decoded = raw.slice(1, -1) }
    } else if (typeof raw === 'string' && raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) decoded = raw.slice(1, -1)
    result[key] = { raw, decoded }
  }
  return result
}

function simulationInput(text, inherited) {
  const targets = targetInput(text)
  const nonDatabase = Object.fromEntries(REQUIRED.filter(key => !TARGETS.includes(key)).map(key => [key, 'synthetic-non-database-value']))
  nonDatabase.BETTER_AUTH_URL = 'https://synthetic.invalid'
  const selected = TARGETS.filter(key => targets[key].raw !== undefined).map(key => key + '=' + targets[key].raw).join('\n') + '\n'
  const synthetic = Object.entries({ ...nonDatabase, VERCEL_ENV: 'production' }).map(([key, value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n'
  // This plain argument object simulates the decoder's existing build contract.
  // It never changes the actual workflow GITHUB_SHA or GITHUB_REF.
  const job = { ...nonDatabase, ...inherited, GITHUB_SHA: APPLICATION, VERCEL_ENV: 'production',
    MIKKA_DEPLOYMENT_ID: 'env-shape-diagnostic' }
  return { targets, text: selected + synthetic, job }
}

function parserModules(env) {
  const base = env.ENV_SHAPE_DEPENDENCIES
  if (!base || !resolve(base).startsWith('/')) fail('dependency_version')
  const require = createRequire(join(resolve(base), 'package.json'))
  const dotenvVersion = require('dotenv/package.json').version
  const nextVersion = require('@next/env/package.json').version
  if (dotenvVersion !== '4.0.0' || nextVersion !== '16.4.1') fail('dependency_version')
  return { dotenv: require('dotenv'), next: require('@next/env') }
}

function legacyChild() {
  if (process.env.ENV_SHAPE_CHILD !== '1') fail('context_refused')
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const { dotenv, next } = parserModules(process.env)
  const folder = mkdtempSync(join(process.env.ENV_SHAPE_PRIVATE_ROOT, 'legacy-'))
  try {
    mkdirSync(join(folder, '.vercel'), { mode: 0o700 })
    const file = join(folder, '.vercel', '.env.production.local')
    writeFileSync(file, input.filledText, { mode: 0o600, flag: 'wx' })
    for (const key of TARGETS) {
      if (typeof input.inherited[key] === 'string') process.env[key] = input.inherited[key]
      else delete process.env[key]
    }
    const loaded = dotenv.config({ path: file })
    if (loaded.error) fail('legacy_failed')
    const cliValues = Object.fromEntries(TARGETS.map(key => [key, process.env[key]]))
    // A clean checkout has no root dotenv files: the pulled file is under .vercel.
    // Project the actual Next child with no root dotenv files. This is not the
    // migration parent: next build cannot write back to the CLI/pnpm parent.
    next.loadEnvConfig(folder, false, { info() {}, error() {} }, true)
    const result = Object.fromEntries(TARGETS.map(key => [key, {
      cli: shape(cliValues[key]), next: shape(process.env[key]),
      cliEqualsInfisical: cliValues[key] === input.inherited[key],
      cliEqualsCurrentBuilder: cliValues[key] === input.current[key],
      nextPreservedCli: process.env[key] === cliValues[key],
    }]))
    process.stdout.write(JSON.stringify(result))
  } finally { rmSync(folder, { recursive: true, force: true }) }
}

function legacyProjection({ filledText, inherited, current, dependencies, privateRoot }) {
  const child = spawnSync(process.execPath, [SELF, '--legacy-child'], {
    cwd: ROOT, input: JSON.stringify({ filledText, inherited, current }), encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ENV_SHAPE_CHILD: '1',
      ENV_SHAPE_DEPENDENCIES: dependencies, ENV_SHAPE_PRIVATE_ROOT: privateRoot },
    timeout: 15_000, maxBuffer: 128 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (child.error || child.status !== 0) fail('legacy_failed')
  let value
  try { value = JSON.parse(child.stdout) } catch { fail('legacy_failed') }
  if (Object.keys(value).sort().join() !== [...TARGETS].sort().join()) fail('legacy_failed')
  return value
}

export function diagnose(text, inherited, { dependencies, privateRoot }) {
  const input = simulationInput(text, inherited)
  const rows = Object.fromEntries(TARGETS.map(key => [key, {
    pulledRaw: shape(input.targets[key].raw), pulledDecoded: shape(input.targets[key].decoded),
    infisical: shape(inherited[key]),
    equalities: { rawEqualsDecoded: input.targets[key].raw === input.targets[key].decoded,
      decodedEqualsInfisical: input.targets[key].decoded === inherited[key] },
  }]))
  let filled, filledText, current, stageCode = null
  try {
    filled = buildEnvironmentValues(input.text, input.job)
    filledText = buildEnvironment(input.text, input.job)
    current = productionBuildEnvironment({ text: filledText, env: input.job, sourceSha: APPLICATION })
  } catch (error) {
    stageCode = /^webDeploy:missing:/.test(error?.message ?? '') ? 'required_value_missing' : 'decoder_refused'
  }
  if (current) {
    const legacy = legacyProjection({ filledText, inherited, current,
      dependencies, privateRoot })
    for (const key of TARGETS) {
      rows[key].normalFill = shape(filled[key])
      rows[key].directBuilder = shape(current[key])
      rows[key].legacyVercel = legacy[key].cli
      rows[key].legacyNext = legacy[key].next
      Object.assign(rows[key].equalities, {
        fillEqualsDecoded: filled[key] === input.targets[key].decoded,
        fillEqualsInfisical: filled[key] === inherited[key],
        currentEqualsFill: current[key] === filled[key],
        legacyCliEqualsInfisical: legacy[key].cliEqualsInfisical,
        legacyCliEqualsCurrentBuilder: legacy[key].cliEqualsCurrentBuilder,
        legacyNextPreservedCli: legacy[key].nextPreservedCli,
      })
    }
  }
  return { decoderCompleted: Boolean(current), stageCode, targets: rows,
    currentTargetsAccepted: Boolean(current) && TARGETS.every(key => shape(current[key]).directAccepted) }
}

export function contextGuard(env, event) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REPOSITORY_OWNER !== 'alexj11324'
    || env.GITHUB_REF !== REF || env.GITHUB_EVENT_NAME !== 'push' || event.deleted
    || event.repository?.full_name !== REPOSITORY || event.ref !== REF
    || event.after !== env.GITHUB_SHA || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
    || env.APPLICATION_SHA !== APPLICATION) fail('context_refused')
}

async function preflight(env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  contextGuard(env, event)
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (actual !== env.GITHUB_SHA) fail('source_refused')
  try {
    execFileSync('git', ['diff', '--exit-code', APPLICATION, '--',
      'scripts/release/web-deploy.mjs', 'scripts/release/build-vercel.mjs',
      'scripts/postgres-connection.mjs', 'lib/deployment-id.mjs'], { cwd: ROOT, stdio: 'pipe' })
  } catch { fail('source_refused') }
  if (!env.GH_TOKEN) fail('main_read_failed')
  const response = await fetch('https://api.github.com/repos/' + REPOSITORY + '/git/ref/heads/main', {
    headers: { authorization: 'Bearer ' + env.GH_TOKEN, accept: 'application/vnd.github+json' },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) fail('main_read_failed')
  const main = await response.json()
  if (main.object?.sha !== APPLICATION) fail('main_changed')
}

async function run(env) {
  await preflight(env)
  parserModules(env)
  if (!env.VERCEL_DEPLOY_TOKEN || TARGETS.some(key => typeof env[key] !== 'string')) fail('secret_missing')
  const privateRoot = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'mikka-env-shape-'))
  try {
    const pulled = spawnSync('npx', ['--yes', 'vercel@65.4.0', 'pull', '--yes',
      '--environment=production', '--token', env.VERCEL_DEPLOY_TOKEN], {
      cwd: privateRoot, env: { PATH: env.PATH, HOME: env.HOME,
        VERCEL_ORG_ID: TEAM, VERCEL_PROJECT_ID: PROJECT, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
    })
    if (pulled.error || pulled.status !== 0) fail('pull_failed')
    const file = join(privateRoot, '.vercel', '.env.production.local')
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail('pulled_file_refused')
    const inherited = Object.fromEntries(TARGETS.map(key => [key, env[key]]))
    const observation = diagnose(readFileSync(file, 'utf8'), inherited, {
      dependencies: env.ENV_SHAPE_DEPENDENCIES, privateRoot,
    })
    return { version: 1, status: 'observed', applicationSource: APPLICATION,
      originalNextSource: OLD_APPLICATION, diagnosticSource: env.GITHUB_SHA,
      versions: { vercel: '65.4.0', dotenv: '4.0.0', nextEnv: '16.4.1', node: process.versions.node },
      method: 'real-production-pull-and-two-Infisical-values; pure-decoder-and-isolated-legacy-parser-comparison',
      legacyScope: { migrationParent: 'legacyVercel is the CLI dotenv4 result inherited by the later independent migrate process',
        nextChild: 'legacyNext is a separate projection with no root dotenv files; Next cannot write back to the migration parent',
        buildPerformed: false },
      otherRequiredValues: 'explicit-synthetic', ...observation,
      builds: 0, migrations: 0, databaseConnections: 0, deployments: 0, runtimeVerified: false }
  } finally { rmSync(privateRoot, { recursive: true, force: true }) }
}

export async function selfTest(env = process.env) {
  parserModules(env)
  const privateRoot = mkdtempSync(join(tmpdir(), 'mikka-env-shape-test-'))
  let passed = 0
  try {
    const urlA = 'postgresql://' + 'first.invalid/database'
    const urlB = 'postgresql://' + 'second.invalid/database'
    const inherited = { MIKKA_DATABASE_URL: urlA, DATABASE_URL: urlA }
    const text = value => TARGETS.map(key => key + '=' + JSON.stringify(value)).join('\n') + '\n'
    const options = { dependencies: env.ENV_SHAPE_DEPENDENCIES, privateRoot }
    const different = diagnose(text(urlB), inherited, options)
    assert.equal(different.targets.DATABASE_URL.equalities.legacyCliEqualsInfisical, true)
    assert.equal(different.targets.DATABASE_URL.equalities.legacyCliEqualsCurrentBuilder, false)
    assert.equal(different.targets.DATABASE_URL.equalities.legacyNextPreservedCli, true); passed++
    const invalid = diagnose(text('not-a-database-url'), inherited, options)
    assert.equal(invalid.targets.DATABASE_URL.directBuilder.directAccepted, false)
    assert.equal(invalid.targets.DATABASE_URL.legacyVercel.directAccepted, true); passed++
    const emptyJob = diagnose(text(urlB), { MIKKA_DATABASE_URL: '', DATABASE_URL: '' }, options)
    assert.equal(emptyJob.targets.DATABASE_URL.directBuilder.directAccepted, true)
    assert.equal(emptyJob.targets.DATABASE_URL.equalities.legacyCliEqualsCurrentBuilder, true); passed++
    const emptyFile = diagnose(text(''), inherited, options)
    assert.equal(emptyFile.targets.DATABASE_URL.equalities.fillEqualsInfisical, true)
    assert.equal(emptyFile.targets.DATABASE_URL.equalities.legacyCliEqualsCurrentBuilder, true); passed++
    const canary = '"shape-canary\\$reference\r\n' + String.fromCharCode(0)
    const privateShape = shape(canary)
    assert.equal(privateShape.hasLF, true); assert.equal(privateShape.hasCR, true)
    assert.equal(privateShape.hasControlByte, true)
    assert.equal(JSON.stringify(privateShape).includes('shape-canary'), false)
    assert.equal(JSON.stringify(different).includes('first.invalid'), false)
    assert.equal(JSON.stringify(different).includes('second.invalid'), false); passed++
    const good = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_REPOSITORY_OWNER: 'alexj11324',
      GITHUB_REF: REF, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'a'.repeat(40), APPLICATION_SHA: APPLICATION }
    const event = { deleted: false, repository: { full_name: REPOSITORY }, ref: REF, after: good.GITHUB_SHA }
    contextGuard(good, event)
    assert.throws(() => contextGuard({ ...good, GITHUB_REF: 'refs/heads/main' }, event), /context_refused/)
    assert.throws(() => contextGuard(good, { ...event, after: 'b'.repeat(40) }), /context_refused/)
    assert.throws(() => contextGuard(good, { ...event, deleted: true }), /context_refused/); passed++
    assert.throws(() => diagnose(text(urlA) + 'DATABASE_URL=' + JSON.stringify(urlB) + '\n', inherited, options), /target_lines_refused/); passed++
    return { status: 'pass', tests: passed, mode: 'offline-synthetic-real-parser', externalRequests: 0 }
  } finally { rmSync(privateRoot, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const mode = process.argv[2]
  try {
    if (mode === '--legacy-child') legacyChild()
    else if (mode === '--self-test') console.log(JSON.stringify(await selfTest()))
    else if (mode === '--check-context') {
      await preflight(process.env); console.log(JSON.stringify({ status: 'pass', check: 'source-and-current-main' }))
    } else if (mode === '--diagnose') {
      let report
      try { report = await run(process.env) }
      catch (error) { report = { version: 1, status: 'failed', code: code(error), builds: 0, migrations: 0,
        databaseConnections: 0, deployments: 0, runtimeVerified: false }; process.exitCode = 1 }
      const folder = join(ROOT, 'production-env-shape-report')
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      writeFileSync(join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      console.log(JSON.stringify({ status: report.status, code: report.code ?? null,
        currentTargetsAccepted: report.currentTargetsAccepted ?? null, builds: 0, databaseConnections: 0, deployments: 0 }))
    } else fail('context_refused')
  } catch (error) { console.error(code(error)); process.exitCode = 1 }
}
