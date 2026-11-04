// Vercel "Ignored Build Step" (vercel.json ignoreCommand).
// Exit 0 skips the build, exit 1 builds. A production deployment is skipped
// only when every file changed since the last deployed commit is documentation
// by the same classifier CI uses (scripts/ci-docs-only.mjs). Anything unclear
// (no previous commit, history not in the clone, a failed diff) builds.
//
// Vercel only deploys main (vercel.json git.deploymentEnabled), and main only
// changes through reviewed pull requests, so the classifier read here is the
// merged one.

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { changedFiles, isDocsOnly } from './ci-docs-only.mjs'

const SHA = /^[0-9a-f]{40}$/

/** True to skip. `diff` returns { files, unsafeModes } for a commit range. */
export function shouldSkip(env, diff = changedFiles, has = commitExists) {
  const previous = env.VERCEL_GIT_PREVIOUS_SHA ?? ''
  const current = env.VERCEL_GIT_COMMIT_SHA ?? ''
  if (env.VERCEL_ENV !== 'production') return { skip: false, reason: 'not a production deployment' }
  if (!SHA.test(previous) || !SHA.test(current)) return { skip: false, reason: 'no previous deployed commit' }
  if (previous === current) return { skip: false, reason: 'same commit (redeploy)' }
  if (!has(previous)) return { skip: false, reason: 'previous commit not in the clone' }
  try {
    const { files, unsafeModes } = diff(previous, current)
    return isDocsOnly(files, unsafeModes)
      ? { skip: true, reason: `${files.length} documentation file(s) only` }
      : { skip: false, reason: `${files.length} changed file(s), not documentation only` }
  } catch (error) {
    return { skip: false, reason: `diff failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function commitExists(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    try {
      // Vercel clones shallowly; fetch the previous commit once if the remote allows it.
      execFileSync('git', ['fetch', '--quiet', '--depth=50', 'origin', sha], { stdio: 'ignore', timeout: 30_000 })
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const { skip, reason } = shouldSkip(process.env)
  console.log(`${skip ? 'Skipping' : 'Building'}: ${reason}`)
  process.exit(skip ? 0 : 1)
}
