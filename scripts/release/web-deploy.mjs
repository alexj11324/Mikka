// Production web build on GitHub Actions (docs/operations/web-deploy.md).
// `vercel pull` writes the production environment to .vercel/.env.production.local,
// but Vercel returns "sensitive" variables empty. The job reads prod:/vercel from
// Infisical (the source Vercel production is synced from) and this fills every
// pulled key that came back empty, so the build sees what a Vercel build saw. It
// also pins the Git identity the migration guard checks and refuses to build
// with a required value missing. The deployment's runtime environment still
// comes from the Vercel project; nothing here is uploaded as configuration.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { shouldSkip } from '../vercel-ignore-build.mjs'

/** Must be non-empty in the final build environment: inlined client keys, the migration targets, the worker build. */
export const REQUIRED = ['MIKKA_DATABASE_URL', 'DATABASE_URL', 'NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'MIKKA_BUILD_BYOS_WORKER', 'NEXT_PUBLIC_COMPUTER_ENABLED']

const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const SHA = /^[a-f0-9]{40}$/

function parse(text) {
  const entries = new Map()
  for (const line of text.split('\n')) {
    const match = LINE.exec(line)
    if (!match) continue
    const raw = match[2].trim()
    let value = raw
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      try { value = JSON.parse(raw) } catch { value = raw.slice(1, -1) }
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) value = raw.slice(1, -1)
    entries.set(match[1], value)
  }
  return entries
}

/** Returns the rewritten dotenv text; throws with variable names only, never values. */
export function buildEnvironment(text, job) {
  if (!SHA.test(job.GITHUB_SHA ?? '')) throw Error('webDeploy:commitShaRequired')
  const entries = parse(text)
  // Only keys the production environment defines, and only where Vercel withheld the value.
  for (const [key, value] of entries) if (!value && job[key]) entries.set(key, job[key])
  entries.set('VERCEL_GIT_PROVIDER', 'github')
  entries.set('VERCEL_GIT_REPO_OWNER', 'alexj11324')
  entries.set('VERCEL_GIT_REPO_SLUG', 'Mikka')
  entries.set('VERCEL_GIT_COMMIT_REF', 'main')
  entries.set('VERCEL_GIT_COMMIT_SHA', job.GITHUB_SHA)
  if (entries.get('VERCEL_ENV') !== 'production') throw Error('webDeploy:productionEnvironmentRequired')
  const missing = REQUIRED.filter(key => !entries.get(key))
  if (missing.length) throw Error(`webDeploy:missing:${missing.join(',')}`)
  return [...entries].map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n'
}

/** Current production deployment's commit, read through the public alias. */
export async function productionSha({ token, fetchImpl = fetch }) {
  const api = path => fetchImpl(`https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=team_C7lwxVVvnUicFli6112mvxpv`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
      .then(response => { if (!response.ok) throw Error(`webDeploy:vercel:${response.status}`); return response.json() })
  const alias = await api('/v4/aliases/app.aspectlylabs.com?projectId=prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH')
  const deployment = await api(`/v13/deployments/${alias.deploymentId}`)
  const sha = deployment.gitSource?.sha ?? deployment.meta?.githubCommitSha
  return SHA.test(sha ?? '') ? sha : ''
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, file] = process.argv.slice(2)
  if (command === 'env') {
    writeFileSync(file, buildEnvironment(readFileSync(file, 'utf8'), process.env), { mode: 0o600 })
    console.log('Build environment ready')
  } else if (command === 'skip') {
    // Same documentation-only rule Vercel's Ignored Build Step used, against what production serves now.
    const previous = await productionSha({ token: process.env.VERCEL_TOKEN })
    const { skip, reason } = shouldSkip({ VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: previous, VERCEL_GIT_COMMIT_SHA: process.env.GITHUB_SHA })
    console.log(`${skip ? 'Skipping' : 'Building'}: ${reason}`)
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\n`, { flag: 'a' })
  } else throw Error('usage: web-deploy.mjs env <file> | skip')
}
