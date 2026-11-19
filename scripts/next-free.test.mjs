import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

/**
 * The Next.js dependency is retired (docs/design/decisions). This test keeps it
 * retired: a reintroduced import, config file or package entry would otherwise
 * pass CI silently, because nothing else reads those names any more.
 *
 * This file names the retired variables and specifiers on purpose, so it
 * excludes itself from every scan.
 */
const root = resolve(import.meta.dirname, '..')
const SELF = 'scripts/next-free.test.mjs'

/** Directories that hold application source. Docs may still mention history. */
const SOURCE = ['app', 'lib', 'components', 'hooks', 'apps', 'tests', 'scripts', 'i18n', 'types', 'packages']

function grep(pattern, extra = []) {
  try {
    const out = execFileSync('git', ['grep', '-nE', pattern, '--', ...SOURCE, `:!${SELF}`, ...extra], { cwd: root, encoding: 'utf8' })
    return out.split('\n').filter(Boolean)
  } catch (error) {
    // git grep exits 1 with no matches, which is the passing case.
    if (error.status === 1) return []
    throw error
  }
}

/** Build and deploy files outside the source directories above. */
async function readIfPresent(path) {
  try { return await readFile(join(root, path), 'utf8') } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
}

test('no source file imports a Next.js module or next-intl', () => {
  const hits = grep(
    "(from|require\\() *['\"](next(/[^'\"]*)?|next-intl(/[^'\"]*)?)['\"]",
    [
      ':!*.md',
      ':!**/*.test.ts',
      ':!**/*.test.tsx',
      ':!**/*.test.mjs',
      // Lint policy fixtures: these strings are the rejected input, not imports.
      ':!scripts/ui-policy.mjs',
      ':!scripts/base-path-policy.mjs',
      // Sandbox acceptance scripts launch a third-party Next fixture that
      // installs the framework itself; the product no longer ships it.
      ':!scripts/acceptance/task-review-preview.mjs',
      ':!scripts/e2b/workspace-ingress-acceptance.mjs',
    ],
  )
  assert.deepEqual(hits, [], 'application code must import the repository\'s own modules instead')
})

test('the package no longer depends on Next.js, next-intl or Vercel Analytics', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  for (const name of ['next', 'next-intl', '@vercel/analytics']) {
    assert.equal(pkg.dependencies?.[name], undefined, `${name} must not be a dependency`)
    assert.equal(pkg.devDependencies?.[name], undefined, `${name} must not be a devDependency`)
  }
  assert.equal(pkg.name, 'mikka', 'the package names the product, not the retired framework')
})

test('no Next.js configuration or build residue remains', async () => {
  for (const name of ['next.config.mjs', 'next.config.js', 'next.config.ts', 'middleware.ts', 'proxy.ts', 'next-env.d.ts', 'instrumentation.ts']) {
    await assert.rejects(readFile(join(root, name)), { code: 'ENOENT' }, `${name} must be gone`)
  }
  const ignore = await readFile(join(root, '.gitignore'), 'utf8')
  assert.doesNotMatch(ignore, /^\.next\/?$/m, '.gitignore must not ignore a build directory that no longer exists')
})

test('no workflow, script or container file still sets a Next.js environment variable', async () => {
  const hits = grep('NEXT_TELEMETRY_DISABLED|NEXT_RUNTIME|NEXT_PHASE', [':!.github/**'])
  assert.deepEqual(hits, [])
  // NEXT_DEPLOYMENT_ID may appear only as an ignored value: the config test
  // pins that the retired variable cannot override MIKKA_DEPLOYMENT_ID.
  const deployment = grep('NEXT_DEPLOYMENT_ID', [':!.github/**'])
  for (const hit of deployment) assert.match(hit, /NEXT_DEPLOYMENT_ID: undefined/, hit)
  // The container and deploy files live outside the source directories.
  for (const file of ['Dockerfile', '.dockerignore', 'cloudflare/wrangler.toml']) {
    const text = await readIfPresent(file)
    assert.doesNotMatch(text, /NEXT_TELEMETRY_DISABLED|NEXT_RUNTIME|NEXT_PHASE|NEXT_DEPLOYMENT_ID/, `${file} must not set a Next.js variable`)
  }
})

test('route handlers no longer export framework-only segment options', () => {
  // Only real route modules: a test may write a fixture module containing the
  // same text, and those files are excluded above.
  const hits = grep("^export const (dynamic|runtime) *=", ['app/**', 'apps/api/routes/**', ':!**/*.test.ts', ':!**/*.test.mjs'])
  assert.deepEqual(hits, [], 'the route manifest reads methods and maxDuration; these exports do nothing')
})
