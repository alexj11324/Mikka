// Publishes the verified official runtime configuration inside Web deploy's
// production queue. The caller then builds on GitHub and uploads --prebuilt;
// this module never requests a Vercel source build.
// Inputs: DESKTOP_TEMPLATE_ID, CLAUDE_TEMPLATE_ID, CODEX_TEMPLATE_ID and SOURCE_SHA (the worker hash,
// workerSha from build-template.py --public --json), the full source commit,
// GITHUB_TOKEN and VERCEL_TEAM_TOKEN. With --current it only prints
// production's MIKKA_CLOUD_WORKER_SHA (empty when unset). All variables go in one request, so production
// never holds a template from one build and a SHA from another (decision 2026-11-01-2335).
import { assertCurrentMain, assertProductionSource } from '../release/web-deploy.mjs'

const API = 'https://api.vercel.com'
export const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
export const TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'

const fail = (code) => { throw new Error(code) }

export async function api(path, { token, method = 'GET', body, fetchImpl = fetch }) {
  const url = new URL(path, API)
  if (url.origin !== API) fail('api_origin_invalid')
  url.searchParams.set('teamId', TEAM)
  let response
  try {
    response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: 'error' })
  } catch { fail(`vercel_api_unavailable ${method} ${url.pathname}`) }
  // The status only: response bodies are not echoed into CI logs.
  if (!response.ok) fail(`vercel_api_http_${response.status} ${method} ${url.pathname}`)
  try { return await response.json() } catch { fail(`vercel_api_invalid_response ${method} ${url.pathname}`) }
}

/** Which variable names each template: the bot's computer, and a task machine per harness. */
export const TEMPLATE_ENV = { desktop: 'E2B_BYO_COMPUTER_TEMPLATE', claude: 'E2B_CLAUDE_TEMPLATE', codex: 'E2B_CODEX_TEMPLATE' }

export function pairEnv({ templates, sourceSha, models }) {
  for (const kind of Object.keys(TEMPLATE_ENV))
    if (!/^[A-Za-z0-9_-]+$/.test(templates?.[kind] ?? '')) fail(`template_id_invalid ${kind}`)
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) fail('source_sha_invalid')
  const required = { desktop: ['claude_code', 'codex'], claude: ['claude_code'], codex: ['codex'] }
  for (const [kind, harnesses] of Object.entries(required)) {
    if (!Array.isArray(models?.[kind])) fail(`template_models_invalid ${kind}`)
    for (const harness of harnesses) {
      const report = models[kind].find(row => row?.harness === harness && row.installed === true)
      if (!report || !(report.models?.length || report.modelSlots?.length)) fail(`template_models_missing ${kind} ${harness}`)
    }
  }
  const catalogue = { version: 1, workerSha: sourceSha, templates: Object.fromEntries(Object.keys(TEMPLATE_ENV).map(kind => [kind, { templateId: templates[kind], models: models[kind] }])) }
  return [
    ...Object.entries(TEMPLATE_ENV).map(([kind, key]) => ({ key, value: templates[kind], type: 'plain', target: ['production'] })),
    { key: 'MIKKA_CLOUD_WORKER_SHA', value: sourceSha, type: 'plain', target: ['production'] },
    { key: 'MIKKA_CLOUD_TEMPLATE_MODELS', value: JSON.stringify(catalogue), type: 'plain', target: ['production'] },
  ]
}

export async function currentWorkerSha({ token, fetchImpl = fetch }) {
  if (!token) fail('vercel_token_unavailable')
  const { envs = [] } = await api(`/v10/projects/${PROJECT}/env`, { token, fetchImpl })
  const row = envs.find((item) => item.key === 'MIKKA_CLOUD_WORKER_SHA' && item.target?.includes('production') && !item.gitBranch)
  if (!row) return ''
  const { value } = await api(`/v1/projects/${PROJECT}/env/${encodeURIComponent(row.id)}`, { token, fetchImpl })
  return /^[0-9a-f]{40}$/.test(value ?? '') ? value : ''
}

export async function publish({ token, githubToken, templates, sourceSha, sourceCommit, models, fetchImpl = fetch, log = console.log }) {
  if (!token) fail('vercel_token_unavailable')
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? '')) fail('official_source_commit_invalid')
  for (const kind of Object.keys(TEMPLATE_ENV)) if (templates?.[kind] !== kind) fail(`official_template_invalid ${kind}`)
  const env = pairEnv({ templates, sourceSha, models })
  env.push({ key: 'MIKKA_CLOUD_WORKER_SOURCE_COMMIT', value: sourceCommit, type: 'plain', target: ['production'] })
  await assertCurrentMain({ expectedBuild: sourceCommit, token: githubToken, fetchImpl })
  await assertProductionSource({ expectedBuild: sourceCommit, token, fetchImpl })
  const call = (path, options = {}) => api(path, { token, fetchImpl, ...options })
  const listedNow = await call(`/v10/projects/${PROJECT}/env`)
  const unchanged = []
  for (const want of env) {
    const row = (listedNow.envs ?? []).find((item) => item.key === want.key && item.target?.includes('production') && !item.gitBranch)
    const value = row ? (await call(`/v1/projects/${PROJECT}/env/${encodeURIComponent(row.id)}`)).value : undefined
    unchanged.push(value === want.value)
  }
  // Environment reads can span a new main push. Recheck at the write boundary,
  // including no-op refreshes, which must not rebuild an obsolete application.
  await assertCurrentMain({ expectedBuild: sourceCommit, token: githubToken, fetchImpl })
  const changed = !unchanged.every(Boolean)
  // An uncertain POST is not retried. The next explicit failed-job rerun reads
  // back first; whether or not this write took, Web deploy still rebuilds.
  if (changed) await call(`/v10/projects/${PROJECT}/env?upsert=true`, { method: 'POST', body: env })
  const listed = await call(`/v10/projects/${PROJECT}/env`)
  for (const want of env) {
    const row = (listed.envs ?? []).find((item) => item.key === want.key && item.target?.includes('production') && !item.gitBranch)
    if (!row) fail(`env_missing ${want.key}`)
    const read = await call(`/v1/projects/${PROJECT}/env/${encodeURIComponent(row.id)}`)
    if (read.value !== want.value) fail(`env_not_updated ${want.key}`)
  }
  log(`production runtime env ${changed ? 'updated' : 'unchanged'} and verified; GitHub Web build required`)
  return { changed, requiresWebBuild: true, sourceCommit, workerSha: sourceSha }
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--current')) {
  console.log(await currentWorkerSha({ token: process.env.VERCEL_TEAM_TOKEN }))
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const templates = { desktop: process.env.DESKTOP_TEMPLATE_ID, claude: process.env.CLAUDE_TEMPLATE_ID, codex: process.env.CODEX_TEMPLATE_ID }
  const result = await publish({ token: process.env.VERCEL_TEAM_TOKEN, githubToken: process.env.GITHUB_TOKEN, templates, sourceSha: process.env.SOURCE_SHA,
    sourceCommit: process.env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT, models: JSON.parse(process.env.TEMPLATE_MODELS ?? '{}') })
  console.log(JSON.stringify({ event: 'official_runtime_env_verified', ...result }))
}
