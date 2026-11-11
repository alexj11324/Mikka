import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { assertDevLocal } from '../dev-local/guard.mjs'

// Match the local acceptance source plus the committed worker install inputs.
// Ignore generated caches and dependencies, but include untracked runtime code.
const sourcePaths = ['app', 'lib', 'packages', 'scripts', 'agents', 'drizzle', 'patches',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json']

/** Official instances install a fixed public source commit, then verify the
 * existing worker digest. This does not build or change an E2B template. */
export function cloudAcceptanceRelease({ root = resolve(import.meta.dirname, '../..'), env = process.env,
  sourceCommit, workerHash,
  revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  status = () => execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...sourcePaths], { cwd: root, encoding: 'utf8' }),
  hash = commit => execFileSync('python3', ['scripts/e2b/build-template.py', '--worker-hash', '--source-ref', commit], { cwd: root, encoding: 'utf8' }).trim(),
} = {}) {
  assert.ok(!env.E2B_ACCEPTANCE_TEMPLATE && !env.LOCAL_LOOP_CLOUD_TEMPLATE_FILE, 'Cloud acceptance uses official E2B templates, not a private template')
  const current = revision(), commit = sourceCommit ?? env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT ?? current
  assert.match(current, /^[a-f0-9]{40}$/, 'The acceptance source revision must be immutable')
  assert.equal(commit, current, 'The cloud worker source must match the acceptance source revision')
  assert.equal(status().trim(), '', 'Cloud acceptance requires clean tracked and untracked source files')
  const actual = hash(commit)
  assert.match(actual, /^[a-f0-9]{40}$/, 'The worker digest must be derived from the fixed source')
  for (const supplied of [workerHash, env.MIKKA_CLOUD_WORKER_SHA, env.E2B_WORKER_SHA]) {
    if (supplied !== undefined) assert.equal(supplied, actual, 'The supplied worker digest is for different source code')
  }
  return Object.freeze({ sourceCommit: commit, workerHash: actual })
}

/** Only the explicitly selected cloud leg may consume this platform credential.
 * Keep it out of the normal app, daemon and TestAccountPool environment. */
export function prepareCloudAcceptance({ items, env = process.env, ...options } = {}) {
  if (!items?.includes('8')) return null
  assertDevLocal(env)
  const release = cloudAcceptanceRelease({ ...options, env })
  const apiKey = env.E2B_API_KEY
  assert.ok(apiKey === undefined || typeof apiKey === 'string' && apiKey.trim() && !/[\r\n\0]/.test(apiKey), 'The cloud acceptance credential is invalid')
  delete env.E2B_API_KEY
  return { release, apiKey }
}
