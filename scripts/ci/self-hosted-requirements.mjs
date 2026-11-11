// Check what a server change introduces relative to the actual PR base or
// push predecessor. Existing installations do not need a retroactive manifest.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const backend = /^(?:app\/(?:api|v1|actions)\/|apps\/(?:api|eve)\/|(?:packages\/)?core\/|lib\/|services\/|workflows\/).+\.(?:[cm]?[jt]s|tsx)$/
const migration = /^drizzle\/.+\.sql$/
const production = path => !/\.(?:test|spec)\.[^.]+$|\/(?:test|tests|fixtures|__tests__)\//.test(path)
export function isSelfHostedBackendInput(path) {
  return production(path) && (backend.test(path) || migration.test(path))
}
const requirements = 'config/self-hosted-requirements.json'
function inventory(source, pattern) {
  return new Set(Array.from(source.matchAll(pattern), match => match[1] || match[2]))
}
function added(previous, current, pattern) {
  const existing = inventory(previous, pattern)
  return [...inventory(current, pattern)].filter(value => !existing.has(value))
}
export function verifyChange(path, before, after, declarations, isTest) {
  if (!isSelfHostedBackendInput(path)) return []
  const env = added(before || '', after, /\b(?:process\.env|env)(?:\.([A-Z][A-Z\d_]+)|\[['"]([A-Z][A-Z\d_]+)['"]\])/g)
  const newCloud = added(before || '', after, /https?:\/\/((?:[\w.-]+\.)?(?:aspectlylabs\.com|vercel\.app))\b/g)
  const exports = added(before || '', after, /\bexport\s+(?:(?:async|default)\s+)*(?:function|const|class)\s+([\w$]+)/g)
  if (before !== null && !env.length && !newCloud.length && !exports.length && !migration.test(path)) return []
  const errors = newCloud.map(host => path + ': new hard-coded hosted origin ' + host + '; use operator configuration')
  const spec = declarations[path]
  if (!spec) return [...errors, path + ': declare self-hosted dependencies in ' + requirements]
  if (!['built-in', 'operator-configured', 'optional-cloud'].includes(spec.mode) ||
      !Array.isArray(spec.environment) || !spec.environment.every(key => typeof key === 'string' && /^[A-Z][A-Z0-9_]+$/.test(key)) ||
      typeof spec.behavior !== 'string' || spec.behavior.trim().length < 1 ||
      typeof spec.test !== 'string' || !isTest(spec.test)) {
    return [...errors, path + ': expected mode, environment, self-hosted behavior and an existing acceptance test']
  }
  if (env.some(key => !spec.environment.includes(key))) errors.push(path + ': undeclared environment inputs: ' + env.filter(key => !spec.environment.includes(key)).join(', '))
  return errors
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const databaseTest = file => /\.db\.test\./.test(file)
// Keep each file's package-defined loaders and flags. Large aggregate scripts
// can contain multiple Node invocations with different runner settings.
export function dependencyTestCommand(spec, scripts) {
  if (!spec.suite && /\.test\.[cm]?js$/.test(spec.test)) {
    return [process.execPath, ...(databaseTest(spec.test) ? ['--test-force-exit'] : []), '--test', spec.test]
  }
  const command = Object.hasOwn(scripts, spec.suite) && scripts[spec.suite]
  if (typeof command !== 'string' || !/^test:[a-z0-9:-]+$/.test(spec.suite) || !command.includes(spec.test)) {
    throw new Error(spec.test + ': name the package test suite that executes this file')
  }
  const parts = command.split(/\s+&&\s+/)
  // Preserve build, install, fixture and cleanup steps in custom suites.
  const onlyTests = parts.every(part => /(?:^|\s)node\s+.*--test(?:\s|$)/.test(part) ||
    /^pnpm (?:run )?test:[a-z0-9:-]+$/.test(part) ||
    /^pnpm --filter [@\w/-]+ exec vitest run [\w./ -]+$/.test(part))
  for (const part of onlyTests ? parts : []) {
    const args = part.trim().split(/\s+/)
    const node = args.indexOf('node')
    const test = args.indexOf('--test')
    if (node < 0 || test <= node || !args.slice(test + 1).includes(spec.test)) continue
    const prefix = args.slice(0, node)
    const flags = args.slice(node + 1, test)
    // Fall back to the original suite for shell expansions, wrappers, globs
    // and post-option flags. Never reinterpret a shell expression as an argv.
    if (!prefix.every(arg => /^[A-Z][A-Z0-9_]*=[\w./-]+$/.test(arg)) ||
        !flags.every(arg => /^[\w./=-]+$/.test(arg)) ||
        !args.slice(test + 1).every(arg => /^[\w./-]+\.[cm]?[jt]sx?$/.test(arg))) continue
    // A database test can share pool teardown with other files in its normal
    // suite. Exit after the isolated file has reported all its test results.
    if (databaseTest(spec.test) && !flags.includes('--test-force-exit')) flags.push('--test-force-exit')
    return [...(prefix.length ? ['env', ...prefix] : []), process.execPath, ...flags, '--test', spec.test]
  }
  return ['pnpm', 'run', spec.suite]
}
export function main(runTests = false, reportDatabase = false) {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const base = event.pull_request?.base?.sha || event.merge_group?.base_sha ||
    (typeof event.before === 'string' && !/^0+$/.test(event.before) && event.before) || 'HEAD^1'
  git('rev-parse', '--verify', base + '^{commit}')
  const declarations = JSON.parse(readFileSync(requirements, 'utf8'))
  const isTest = file => /^(?:scripts|tests|apps|packages|lib|app|hooks|cloudflare|services|components)\/[\w./-]+$/.test(file) &&
    !file.includes('..') && /(?:\.test\.[cm]?[jt]sx?$|\/acceptance\/)/.test(file) &&
    existsSync(file) && statSync(file).isFile()
  const paths = git('diff', '--name-only', '--no-renames', '--diff-filter=AM', '-z', base, 'HEAD').split('\0').filter(Boolean)
  const errors = []
  for (const path of paths.filter(isSelfHostedBackendInput)) {
    const prior = spawnSync('git', ['show', base + ':' + path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    errors.push(...verifyChange(path, prior.status === 0 ? prior.stdout : null, readFileSync(path, 'utf8'), declarations, isTest))
  }
  const full = paths.includes(requirements) || paths.includes('config/self-hosted-stable-version') || process.env.GITHUB_REF_TYPE === 'tag'
  const commands = new Map()
  let needsDatabase = false
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts
  for (const [file, spec] of Object.entries(declarations)) {
    if (!full && !paths.includes(file) && !paths.includes(spec?.test)) continue
    if (typeof spec?.test !== 'string' || !isTest(spec.test)) throw new Error(file + ': missing declared acceptance test')
    const command = dependencyTestCommand(spec, scripts)
    commands.set(JSON.stringify(command), command)
    if (databaseTest(spec.test)) needsDatabase = true
  }
  if (errors.length) throw new Error(errors.join('\n'))
  if (reportDatabase) {
    console.log(needsDatabase)
    return
  }
  if (runTests) {
    for (const [bin, ...args] of commands.values()) execFileSync(bin, args, { stdio: 'inherit', env: { ...process.env, MIKKA_EDITION: 'community' } })
  }
  console.log('Self-hosted dependency declarations verified against ' + base)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2] === '--run-tests', process.argv[2] === '--needs-db')
}
