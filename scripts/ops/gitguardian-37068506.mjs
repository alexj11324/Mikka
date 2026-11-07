import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// One reviewed disposition, not a general-purpose security administration tool.
export const TARGET = Object.freeze({
  repository: 'alexj11324/Mikka', repositoryId: 1427517699, ownerId: 183887963,
  ref: 'refs/heads/ops/gitguardian-37068506',
  base: '02db9c4b01698c28502949bb884ba87e9f39fbf7',
  workspace: 837165, incident: 37068506,
  source: '518b9d32eb9315656173ae7a074c920546fdcb70',
  file: 'docker-compose.yml', blob: '80bf3b1e101f3f8fc34ae95640f2f3017a708ce8',
  lines: [13, 14, 33],
})
const API = 'https://api.gitguardian.com'
const INCIDENT = `/v1/incidents/secrets/${TARGET.incident}`
export const ROUTES = Object.freeze({
  token: '/v1/api_tokens/self', incident: `${INCIDENT}?with_occurrences=0`,
  occurrences: `/v1/occurrences/secrets?incident_id=${TARGET.incident}&per_page=4`,
  ignore: `${INCIDENT}/ignore`,
})
const OWNED = ['.github/workflows/gitguardian-37068506.yml', 'scripts/ops/gitguardian-37068506.mjs', 'scripts/ops/gitguardian-37068506.test.mjs']
class GuardError extends Error { constructor(code) { super(code); this.code = code } }
const requireThat = (value, code) => { if (!value) throw new GuardError(code) }
const positive = value => Number.isSafeInteger(value) && value > 0
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function validateExecution({ env, event, head, parent, changed }) {
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'push'
    && env.GITHUB_REPOSITORY === TARGET.repository && env.GITHUB_REPOSITORY_ID === String(TARGET.repositoryId)
    && env.GITHUB_REPOSITORY_OWNER_ID === String(TARGET.ownerId) && env.GITHUB_REF === TARGET.ref
    && env.GITHUB_ACTOR === 'alexj11324' && env.GITHUB_RUN_ATTEMPT === '1', 'EXECUTION_SCOPE')
  requireThat(event?.repository?.full_name === TARGET.repository && event.repository.id === TARGET.repositoryId
    && event.repository.owner?.id === TARGET.ownerId && event.repository.fork === false
    && event.ref === TARGET.ref && event.after === head && env.GITHUB_SHA === head
    && !event.deleted && !event.forced && /^[a-f0-9]{40}$/.test(head), 'EVENT_SCOPE')
  requireThat(parent === TARGET.base && changed.length === OWNED.length
    && [...changed].sort().every((value, i) => value === [...OWNED].sort()[i]), 'SOURCE_SCOPE')
  return { checkout: head, base: parent, ref: TARGET.ref }
}

export function validateSource(bytes) {
  const body = Buffer.from(bytes)
  const sha = createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex')
  requireThat(sha === TARGET.blob, 'SOURCE_BLOB')
  const lines = body.toString('utf8').split('\n')
  const names = ['MIKKA_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_PASSWORD']
  TARGET.lines.forEach((line, i) => {
    requireThat(lines[line - 1]?.trimStart().startsWith(`${names[i]}:`)
      && /\$\{POSTGRES_PASSWORD:\?[^}]+\}/.test(lines[line - 1])
      && !lines[line - 1].includes('POSTGRES_PASSWORD:-'), 'SOURCE_EXPRESSION')
  })
  return { revision: TARGET.source, path: TARGET.file, blob: sha, lines: TARGET.lines }
}

export function validateToken(token, now = Date.now()) {
  requireThat(token?.workspace_id === TARGET.workspace && token.status === 'active' && token.revoked_at == null
    && (token.expire_at == null || Date.parse(token.expire_at) > now), 'TOKEN_WORKSPACE_OR_STATUS')
  requireThat(Array.isArray(token.scopes) && ['incidents:read', 'incidents:write'].every(scope => token.scopes.includes(scope)), 'TOKEN_SCOPE')
}

export function validateIncident(incident) {
  requireThat(incident?.id === TARGET.incident && incident.occurrences_count === 3
    && incident.detector?.display_name === 'Generic Password'
    && incident.gitguardian_url === `https://dashboard.gitguardian.com/workspace/${TARGET.workspace}/incidents/${TARGET.incident}`,
  'INCIDENT_SCOPE')
  requireThat(incident.occurrences == null || (Array.isArray(incident.occurrences) && incident.occurrences.length === 0), 'INCIDENT_PROJECTION')
  requireThat(['TRIGGERED', 'ASSIGNED', 'IGNORED'].includes(incident.status), 'INCIDENT_STATUS')
  if (incident.status === 'IGNORED') requireThat(incident.ignore_reason === 'false_positive', 'INCIDENT_REASON')
  else requireThat(incident.ignore_reason == null, 'INCIDENT_REASON')
  return { status: incident.status, ignoreReason: incident.ignore_reason ?? null }
}

export function validateOccurrences(rows, headers) {
  // Unfiltered by source/commit: an extra occurrence anywhere must stop the write.
  requireThat(Array.isArray(rows) && rows.length === 3 && !/rel\s*=\s*["']?next/i.test(headers.get('link') ?? ''), 'OCCURRENCE_COUNT')
  const ids = new Set(), sourceIds = new Set(), lines = []
  for (const row of rows) {
    requireThat(positive(row.id) && !ids.has(row.id) && row.incident_id === TARGET.incident
      && row.sha === TARGET.source && row.filepath === TARGET.file && row.change_type === 'addition'
      && row.source?.type === 'github' && typeof row.source.full_name === 'string'
      && row.source.full_name.toLowerCase() === TARGET.repository.toLowerCase()
      && typeof row.source.url === 'string' && row.source.url.toLowerCase() === `https://github.com/${TARGET.repository.toLowerCase()}`
      && positive(row.source.id)
      && String(row.source.external_id) === String(TARGET.repositoryId), 'OCCURRENCE_SCOPE')
    requireThat(Array.isArray(row.matches) && row.matches.length === 1, 'MATCH_COUNT')
    const match = row.matches[0]
    requireThat(TARGET.lines.includes(match.post_line_start) && match.post_line_start === match.post_line_end, 'MATCH_POSITION')
    ids.add(row.id); sourceIds.add(row.source.id); lines.push(match.post_line_start)
  }
  requireThat(sourceIds.size === 1 && [...lines].sort((a,b) => a-b).join(',') === TARGET.lines.join(','), 'MATCH_COVERAGE')
  return [...ids].sort((a,b) => a-b)
}

export function guardianClient(token, fetcher = fetch, record = () => {}) {
  requireThat(typeof token === 'string' && token.length > 0, 'TOKEN_MISSING')
  return async function request(route, method = 'GET') {
    requireThat((method === 'GET' && [ROUTES.token, ROUTES.incident, ROUTES.occurrences].includes(route))
      || (method === 'POST' && route === ROUTES.ignore), 'API_ROUTE')
    let response
    try {
      response = await fetcher(`${API}${route}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Token ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-privacy-mode': 'true' },
        ...(method === 'POST' ? { body: JSON.stringify({ ignore_reason: 'false_positive' }) } : {}),
      })
    } catch { throw new GuardError('API_TRANSPORT') }
    record({ operation: Object.entries(ROUTES).find(([, path]) => path === route)[0], status: response.status })
    if (response.status !== 200) { await response.body?.cancel(); throw new GuardError('API_HTTP') }
    requireThat(response.headers.get('content-type')?.includes('application/json'), 'API_CONTENT_TYPE')
    let data
    try { data = await response.json() } catch { throw new GuardError('API_JSON') }
    return { data, headers: response.headers }
  }
}

export async function dispose({ request, report }) {
  validateToken((await request(ROUTES.token)).data)
  report.workspaceVerified = true
  const before = validateIncident((await request(ROUTES.incident)).data)
  const occurrenceReply = await request(ROUTES.occurrences)
  report.occurrenceIds = validateOccurrences(occurrenceReply.data, occurrenceReply.headers)
  report.before = before
  // Recheck scope/count/state immediately before the only permitted mutation.
  const current = validateIncident((await request(ROUTES.incident)).data)
  if (current.status !== 'IGNORED') {
    report.writeAttempts = 1
    const changed = validateIncident((await request(ROUTES.ignore, 'POST')).data)
    requireThat(changed.status === 'IGNORED' && changed.ignoreReason === 'false_positive', 'WRITE_READBACK')
  }
  const after = validateIncident((await request(ROUTES.incident)).data)
  requireThat(after.status === 'IGNORED' && after.ignoreReason === 'false_positive', 'FINAL_READBACK')
  report.after = after
  report.result = 'verified'
}

async function main() {
  const report = { incident: TARGET.incident, workspace: TARGET.workspace, result: 'blocked', writeAttempts: 0, requests: [],
    secretContentRequested: false, scannerConfigurationChanged: false, checkRunEditedOrSkipped: false }
  try {
    requireThat(process.argv.length === 3 && ['--preflight', '--apply'].includes(process.argv[2]), 'MODE')
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    report.execution = validateExecution({ env: process.env, event, head: git('rev-parse', 'HEAD'),
      parent: git('rev-parse', 'HEAD^'), changed: git('diff', '--name-only', 'HEAD^', 'HEAD').split('\n').filter(Boolean) })
    report.source = validateSource(execFileSync('git', ['show', `${TARGET.source}:${TARGET.file}`], { stdio: ['ignore', 'pipe', 'pipe'] }))
    if (process.argv[2] === '--preflight') report.result = 'source_verified'
    else await dispose({ request: guardianClient(process.env.GITGUARDIAN_API_TOKEN, fetch, row => report.requests.push(row)), report })
  } catch (error) {
    report.error = error instanceof GuardError ? error.code : 'DISPOSITION_FAILED'
    process.exitCode = 1
  }
  // Closed metadata only. Never serialize a token, provider payload, match text or raw error.
  const safe = JSON.stringify(report)
  console.log(safe)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### GitGuardian incident ${TARGET.incident}\n\n\`\`\`json\n${safe}\n\`\`\`\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
