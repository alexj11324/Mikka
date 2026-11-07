// DATABASE_URL is supplied by the existing Vercel production environment, not
// prod:/vercel. Keep the pulled file private and export only this one value.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const CLI = 'vercel@65.4.0'
const ORG = 'team_C7lwxVVvnUicFli6112mvxpv'
const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
class ProductionEnvError extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = code => { throw new ProductionEnvError(code) }

function pullWithVercel(directory, env, execute = execFileSync) {
  execute('npx', ['--yes', CLI, 'pull', '--yes', '--environment=production', '--token', env.VERCEL_DEPLOY_TOKEN], {
    cwd: directory, env: { ...env, VERCEL_ORG_ID: ORG, VERCEL_PROJECT_ID: PROJECT },
    stdio: 'ignore', timeout: 120_000,
  })
}

function pulledDatabase(directory) {
  let project, text
  try { project = JSON.parse(readFileSync(join(directory, '.vercel', 'project.json'), 'utf8')) }
  catch { fail('production_env_project') }
  if (project?.orgId !== ORG || project?.projectId !== PROJECT) fail('production_env_project')
  try { text = readFileSync(join(directory, '.vercel', '.env.production.local'), 'utf8') }
  catch { fail('production_env_file') }
  const values = new Map()
  for (const line of text.split(/\r?\n/)) {
    const match = /^(VERCEL_ENV|DATABASE_URL)=(.*)$/.exec(line)
    if (!match) continue
    if (values.has(match[1])) fail('production_env_format')
    const raw = match[2].trim()
    let value = raw
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw) } catch { fail('production_env_format') }
    } else if (raw.startsWith("'")) {
      if (raw.length < 2 || !raw.endsWith("'")) fail('production_env_format')
      value = raw.slice(1, -1)
    }
    if (typeof value !== 'string') fail('production_env_format')
    values.set(match[1], value)
  }
  if (values.get('VERCEL_ENV') !== 'production') fail('production_env_environment')
  const value = values.get('DATABASE_URL')
  // eslint-disable-next-line no-control-regex -- reject whitespace and controls in the private URL
  if (!value || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) fail('production_env_database')
  let url
  try { url = new URL(value) } catch { fail('production_env_database') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) fail('production_env_database')
  return value
}

export function exportProductionDatabase({ env = process.env, pull = pullWithVercel, remove = rmSync,
  emit = text => writeSync(1, text), append = appendFileSync } = {}) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'alexj11324/Mikka'
    || env.GITHUB_REF !== 'refs/heads/ops/1515-1517-acceptance' || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')
    || !isAbsolute(env.RUNNER_TEMP ?? '') || !isAbsolute(env.GITHUB_ENV ?? '')) fail('production_env_scope')
  if (!env.VERCEL_DEPLOY_TOKEN || /[\r\n\0]/.test(env.VERCEL_DEPLOY_TOKEN)) fail('production_env_token_required')
  let directory, database
  try {
    try {
      directory = mkdtempSync(join(env.RUNNER_TEMP, 'issues-production-env-'))
      chmodSync(directory, 0o700)
    } catch { fail('production_env_temporary_directory') }
    try { pull(directory, env) } catch { fail('production_env_pull_failed') }
    database = pulledDatabase(directory)
  } finally {
    if (directory) {
      try { remove(directory, { recursive: true, force: true }) }
      catch { fail('production_env_cleanup_failed') }
    }
  }
  // Export only after the private files are gone. Never source the entire env:
  // VERCEL and other deployment-only flags are invalid in this cleanup process.
  try {
    emit(`::add-mask::${database.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`)
    append(env.GITHUB_ENV, `DATABASE_URL=${database}\n`, { mode: 0o600 })
  } catch { fail('production_env_export_failed') }
}

export function runProductionEnvironment(options = {}) {
  const report = options.report ?? (code => console.log(code))
  try {
    exportProductionDatabase(options)
    report('production_env_ready')
    return 0
  } catch (error) {
    report(error instanceof ProductionEnvError ? error.code : 'production_env_internal')
    return 1
  }
}

function selfTest() {
  const database = 'postgresql://fixture:credential%25sentinel@db.example/workspace'
  const token = 'fixture-token-must-not-be-logged'
  const foreign = 'unrelated-secret-must-not-be-exported'
  let passed = 0
  const failed = []
  function check(name, change = {}, expected = 'production_env_ready') {
    const root = mkdtempSync(join(tmpdir(), 'issues-env-test-'))
    const envFile = join(root, 'github-env')
    const emitted = []
    const reported = []
    let directory
    let pullCalls = 0
    const env = {
      GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka',
      GITHUB_REF: 'refs/heads/ops/1515-1517-acceptance', GITHUB_RUN_ID: '123',
      RUNNER_TEMP: root, GITHUB_ENV: envFile, VERCEL_DEPLOY_TOKEN: token,
      MIKKA_DATABASE_URL: 'postgres://different-fixture/application',
      ...change.env,
    }
    writeFileSync(envFile, 'PREEXISTING=kept\n', { mode: 0o600 })
    try {
      const result = runProductionEnvironment({
        env, emit: text => emitted.push(text), report: code => reported.push(code),
        ...(change.appendFails ? { append: () => { throw Error(database) } } : {}),
        ...(change.removeFails ? { remove: () => { throw Error(token) } } : {}),
        pull: (path, childEnv) => pullWithVercel(path, childEnv, (command, args, options) => {
          directory = path
          pullCalls++
          assert.equal(command, 'npx')
          assert.deepEqual(args, ['--yes', CLI, 'pull', '--yes', '--environment=production', '--token', token])
          assert.equal(options.cwd, path)
          assert.equal(options.env.VERCEL_ORG_ID, ORG)
          assert.equal(options.env.VERCEL_PROJECT_ID, PROJECT)
          assert.equal(options.stdio, 'ignore')
          assert.equal(statSync(path).mode & 0o777, 0o700)
          mkdirSync(join(path, '.vercel'))
          writeFileSync(join(path, 'private-output.log'), `${token}\n${foreign}`)
          if (change.pullFails) throw Error(`${token}: ${foreign}`)
          writeFileSync(join(path, '.vercel', 'project.json'), change.projectText ?? JSON.stringify({ orgId: ORG, projectId: PROJECT, ...change.project }))
          if (!change.missingFile) writeFileSync(join(path, '.vercel', '.env.production.local'), change.text ?? [
            'VERCEL_ENV="production"', `DATABASE_URL=${JSON.stringify(database)}`,
            'VERCEL="1"', `OTHER_SECRET=${JSON.stringify(foreign)}`,
          ].join('\n'))
        }),
      })
      assert.deepEqual(reported, [expected])
      assert.equal(result, expected === 'production_env_ready' ? 0 : 1)
      assert.equal(pullCalls, change.noPull ? 0 : 1)
      if (directory && !change.removeFails) assert.equal(existsSync(directory), false)
      assert.ok(!reported.join('').includes(token) && !reported.join('').includes(foreign) && !reported.join('').includes(database))
      assert.ok(!emitted.join('').includes(token) && !emitted.join('').includes(foreign))
      assert.equal(env.DATABASE_URL, undefined)
      if (expected === 'production_env_ready') {
        assert.deepEqual(emitted, [`::add-mask::${database.replaceAll('%', '%25')}\n`])
        assert.equal(readFileSync(envFile, 'utf8'), `PREEXISTING=kept\nDATABASE_URL=${database}\n`)
      } else {
        assert.equal(readFileSync(envFile, 'utf8'), 'PREEXISTING=kept\n')
        if (!change.appendFails) assert.deepEqual(emitted, [])
      }
      passed++
    } catch { failed.push(name) }
    finally { rmSync(root, { recursive: true, force: true }) }
  }
  check('only target exported, private files removed and fixed CLI/project used')
  check('outside Actions refuses before pull', { env: { GITHUB_ACTIONS: 'false' }, noPull: true }, 'production_env_scope')
  check('wrong branch refuses before pull', { env: { GITHUB_REF: 'refs/heads/main' }, noPull: true }, 'production_env_scope')
  check('missing token refuses before pull', { env: { VERCEL_DEPLOY_TOKEN: '' }, noPull: true }, 'production_env_token_required')
  check('wrong project refuses', { project: { projectId: 'different' } }, 'production_env_project')
  check('wrong team refuses', { project: { orgId: 'different' } }, 'production_env_project')
  check('malformed project refuses', { projectText: '{' }, 'production_env_project')
  check('non-production refuses', { text: `VERCEL_ENV="preview"\nDATABASE_URL=${JSON.stringify(database)}` }, 'production_env_environment')
  check('missing file refuses', { missingFile: true }, 'production_env_file')
  check('missing database never aliases application database', { text: 'VERCEL_ENV="production"' }, 'production_env_database')
  check('empty database refuses', { text: 'VERCEL_ENV="production"\nDATABASE_URL=""' }, 'production_env_database')
  check('duplicate target refuses', { text: `VERCEL_ENV="production"\nDATABASE_URL=${JSON.stringify(database)}\nDATABASE_URL=${JSON.stringify(database)}` }, 'production_env_format')
  check('malformed quoting refuses', { text: 'VERCEL_ENV="production"\nDATABASE_URL="postgres://fixture@db.example/workspace' }, 'production_env_format')
  check('decoded newline refuses', { text: `VERCEL_ENV="production"\nDATABASE_URL=${JSON.stringify(`${database}\nINJECTED=value`)}` }, 'production_env_database')
  check('decoded carriage return refuses', { text: `VERCEL_ENV="production"\nDATABASE_URL=${JSON.stringify(`${database}\rINJECTED=value`)}` }, 'production_env_database')
  check('decoded NUL refuses', { text: `VERCEL_ENV="production"\nDATABASE_URL=${JSON.stringify(`${database}\0`)}` }, 'production_env_database')
  check('non-postgres refuses', { text: 'VERCEL_ENV="production"\nDATABASE_URL="https://db.example/workspace"' }, 'production_env_database')
  check('malformed URL refuses', { text: 'VERCEL_ENV="production"\nDATABASE_URL="postgres://"' }, 'production_env_database')
  check('pull failure cleans files without raw errors', { pullFails: true }, 'production_env_pull_failed')
  check('cleanup failure prevents export without raw errors', { removeFails: true }, 'production_env_cleanup_failed')
  check('export failure never prints exception', { appendFails: true }, 'production_env_export_failed')
  console.log(JSON.stringify({ selfTest: true, passed, failed }))
  return failed.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') process.exitCode = selfTest()
    else if (process.argv.length === 2) process.exitCode = runProductionEnvironment()
    else fail('production_env_arguments')
  } catch (error) {
    console.log(error instanceof ProductionEnvError ? error.code : 'production_env_internal')
    process.exitCode = 1
  }
}
