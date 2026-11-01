// Points production at a freshly built, public E2B template, then redeploys production.
// Inputs: TEMPLATE_ID and SOURCE_SHA (from build-template.py --public --json), VERCEL_TEAM_TOKEN.
// Both variables go in one request, so production never holds a template from one build and a SHA from another.
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

export function pairEnv({ templateId, sourceSha }) {
  if (!/^[A-Za-z0-9_-]+$/.test(templateId ?? '')) fail('template_id_invalid')
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) fail('source_sha_invalid')
  return [
    { key: 'E2B_BYO_COMPUTER_TEMPLATE', value: templateId, type: 'plain', target: ['production'] },
    { key: 'MIKKA_CLOUD_WORKER_SHA', value: sourceSha, type: 'plain', target: ['production'] },
  ]
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function publish({ token, templateId, sourceSha, fetchImpl = fetch, wait = sleep, log = console.log, maxPolls = 120 }) {
  if (!token) fail('vercel_token_unavailable')
  const env = pairEnv({ templateId, sourceSha })
  const call = (path, options = {}) => api(path, { token, fetchImpl, ...options })

  await call(`/v10/projects/${PROJECT}/env?upsert=true`, { method: 'POST', body: env })
  const listed = await call(`/v10/projects/${PROJECT}/env`)
  for (const want of env) {
    const row = (listed.envs ?? []).find((item) => item.key === want.key && item.target?.includes('production') && !item.gitBranch)
    if (!row) fail(`env_missing ${want.key}`)
    const read = await call(`/v1/projects/${PROJECT}/env/${encodeURIComponent(row.id)}`)
    if (read.value !== want.value) fail(`env_not_updated ${want.key}`)
  }
  log(`production env: E2B_BYO_COMPUTER_TEMPLATE=${templateId} MIKKA_CLOUD_WORKER_SHA=${sourceSha}`)

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await publish({ token: process.env.VERCEL_TEAM_TOKEN, templateId: process.env.TEMPLATE_ID, sourceSha: process.env.SOURCE_SHA })
  console.log(`production deployment ready: ${result.deploymentId}`)
}
