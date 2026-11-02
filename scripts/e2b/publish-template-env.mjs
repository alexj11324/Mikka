// Points production at freshly built, public E2B templates, then redeploys production.
// Inputs: DESKTOP_TEMPLATE_ID, CLAUDE_TEMPLATE_ID, CODEX_TEMPLATE_ID and SOURCE_SHA (the worker hash,
// workerSha from build-template.py --public --json), VERCEL_TEAM_TOKEN. With --current it only prints
// production's MIKKA_CLOUD_WORKER_SHA (empty when unset). All variables go in one request, so production
// never holds a template from one build and a SHA from another (decision 2026-11-01-2335).
const API = 'https://api.vercel.com'
export const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
export const TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const IN_FLIGHT = new Set(['QUEUED', 'INITIALIZING', 'BUILDING'])

const fail = (code) => { throw new Error(code) }

export async function api(path, { token, method = 'GET', body, fetchImpl = fetch }) {
  const url = new URL(path, API)
  if (url.origin !== API) fail('api_origin_invalid')
  url.searchParams.set('teamId', TEAM)
  const response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: 'error' })
  // The status only: response bodies are not echoed into CI logs.
  if (!response.ok) fail(`vercel_api_http_${response.status} ${method} ${url.pathname}`)
  return response.json()
}

/** Which variable names each template: the bot's computer, and a task machine per harness. */
export const TEMPLATE_ENV = { desktop: 'E2B_BYO_COMPUTER_TEMPLATE', claude: 'E2B_CLAUDE_TEMPLATE', codex: 'E2B_CODEX_TEMPLATE' }

export function pairEnv({ templates, sourceSha }) {
  for (const kind of Object.keys(TEMPLATE_ENV))
    if (!/^[A-Za-z0-9_-]+$/.test(templates?.[kind] ?? '')) fail(`template_id_invalid ${kind}`)
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) fail('source_sha_invalid')
  return [
    ...Object.entries(TEMPLATE_ENV).map(([kind, key]) => ({ key, value: templates[kind], type: 'plain', target: ['production'] })),
    { key: 'MIKKA_CLOUD_WORKER_SHA', value: sourceSha, type: 'plain', target: ['production'] },
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function publish({ token, templates, sourceSha, fetchImpl = fetch, wait = sleep, log = console.log, maxPolls = 120 }) {
  if (!token) fail('vercel_token_unavailable')
  const env = pairEnv({ templates, sourceSha })
  const call = (path, options = {}) => api(path, { token, fetchImpl, ...options })

  await call(`/v10/projects/${PROJECT}/env?upsert=true`, { method: 'POST', body: env })
  const listed = await call(`/v10/projects/${PROJECT}/env`)
  for (const want of env) {
    const row = (listed.envs ?? []).find((item) => item.key === want.key && item.target?.includes('production') && !item.gitBranch)
    if (!row) fail(`env_missing ${want.key}`)
    const read = await call(`/v1/projects/${PROJECT}/env/${encodeURIComponent(row.id)}`)
    if (read.value !== want.value) fail(`env_not_updated ${want.key}`)
  }
  log(`production env: ${env.map((item) => `${item.key}=${item.value}`).join(' ')}`)

  // A production build already running (e.g. the git deploy of this same push) started with the old
  // pair. Let it finish first, so the redeploy below is the last one and carries the new pair.
  let latest
  for (let poll = 0; ; poll++) {
    const { deployments = [] } = await call(`/v6/deployments?projectId=${PROJECT}&target=production&limit=20`)
    if (!deployments.some((item) => IN_FLIGHT.has(item.state ?? item.readyState))) {
      latest = deployments.find((item) => (item.state ?? item.readyState) === 'READY')
      break
    }
    if (poll >= maxPolls) fail('production_build_still_running')
    await wait(10_000)
  }
  if (!latest) fail('no_ready_production_deployment')

  const created = await call('/v13/deployments?forceNew=1', { method: 'POST',
    body: { name: latest.name, deploymentId: latest.uid ?? latest.id, target: 'production' } })
  log(`redeploy: ${created.id} from ${latest.uid ?? latest.id}`)
  for (let poll = 0; ; poll++) {
    const state = (await call(`/v13/deployments/${encodeURIComponent(created.id)}`)).readyState
    if (state === 'READY') return { deploymentId: created.id }
    if (state === 'ERROR' || state === 'CANCELED') fail(`redeploy_${state.toLowerCase()}`)
    if (poll >= maxPolls) fail('redeploy_timeout')
    await wait(10_000)
  }
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--current')) {
  console.log(await currentWorkerSha({ token: process.env.VERCEL_TEAM_TOKEN }))
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const templates = { desktop: process.env.DESKTOP_TEMPLATE_ID, claude: process.env.CLAUDE_TEMPLATE_ID, codex: process.env.CODEX_TEMPLATE_ID }
  const result = await publish({ token: process.env.VERCEL_TEAM_TOKEN, templates, sourceSha: process.env.SOURCE_SHA })
  console.log(`production deployment ready: ${result.deploymentId}`)
}
