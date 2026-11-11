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
export function main() {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const base = event.pull_request?.base?.sha || event.merge_group?.base_sha ||
    (typeof event.before === 'string' && !/^0+$/.test(event.before) && event.before) || 'HEAD^1'
  git('rev-parse', '--verify', base + '^{commit}')
  const declarations = JSON.parse(readFileSync(requirements, 'utf8'))
  const isTest = file => /^(?:scripts|tests|apps|packages|lib|app)\/[\w./-]+$/.test(file) &&
    !file.includes('..') && /(?:\.test\.[cm]?[jt]s$|\/acceptance\/)/.test(file) &&
    existsSync(file) && statSync(file).isFile()
  const paths = git('diff', '--name-only', '--no-renames', '--diff-filter=AM', '-z', base, 'HEAD').split('\0').filter(Boolean)
  const errors = []
  for (const path of paths.filter(isSelfHostedBackendInput)) {
    const prior = spawnSync('git', ['show', base + ':' + path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    errors.push(...verifyChange(path, prior.status === 0 ? prior.stdout : null, readFileSync(path, 'utf8'), declarations, isTest))
  }
  if (errors.length) throw new Error(errors.join('\n'))
  console.log('Self-hosted dependency declarations verified against ' + base)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
