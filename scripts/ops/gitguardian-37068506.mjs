import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// One reviewed disposition, not a general-purpose security administration tool.
export const TARGET = Object.freeze({
  repository: 'alexj11324/Mikka', repositoryId: 1427517699, ownerId: 183887963,
  ref: 'refs/heads/ops/gitguardian-37068506',
  base: '9773f52979eb7b81d30c06118350014b14beb20e',
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
  inspectionOccurrences: `/v1/occurrences/secrets?incident_id=${TARGET.incident}&per_page=5`,
  ignore: `${INCIDENT}/ignore`, reopen: `${INCIDENT}/reopen`,
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

export function inspectIncident(incident) {
  const expectedPath = `/workspace/${TARGET.workspace}/incidents/${TARGET.incident}`
  const expectedUrl = `https://dashboard.gitguardian.com${expectedPath}`
  const detector = incident?.detector?.display_name
  let url = null
  if (typeof incident?.gitguardian_url === 'string') {
    try { url = new URL(incident.gitguardian_url) } catch { /* Only closed booleans below. */ }
  }
  const parts = url?.pathname.split('/').filter(Boolean) ?? []
  return {
    idMatches: incident?.id === TARGET.incident,
    expectedCount: 3,
    actualCount: Number.isSafeInteger(incident?.occurrences_count) && incident.occurrences_count >= 0 ? incident.occurrences_count : null,
    countMatches: incident?.occurrences_count === 3,
    detectorExactMatches: detector === 'Generic Password',
    detectorCasefoldMatches: typeof detector === 'string' && detector.toLowerCase() === 'generic password',
    urlExactMatches: incident?.gitguardian_url === expectedUrl,
    urlParseable: url !== null,
    urlHttps: url?.protocol === 'https:',
    urlHostMatches: url?.host === 'dashboard.gitguardian.com',
    urlWorkspaceMatches: parts[0] === 'workspace' && parts[1] === String(TARGET.workspace),
    urlIncidentMatches: parts[2] === 'incidents' && parts[3] === String(TARGET.incident),
    urlPathMatches: url?.pathname === expectedPath,
    urlPathTrailingSlashMatches: url?.pathname === `${expectedPath}/`,
    urlNoCredentials: url !== null && url.username === '' && url.password === '',
    urlNoQueryOrFragment: url !== null && url.search === '' && url.hash === '',
    status: ['TRIGGERED', 'ASSIGNED', 'RESOLVED', 'IGNORED'].includes(incident?.status) ? incident.status : 'OTHER',
    projectionNullOrAbsent: incident?.occurrences == null,
    projectionEmpty: Array.isArray(incident?.occurrences) && incident.occurrences.length === 0,
  }
}

export async function inspect({ request, report }) {
  validateToken((await request(ROUTES.token)).data)
  report.workspaceVerified = true
  report.inspection = inspectIncident((await request(ROUTES.incident)).data)
  requireThat(report.inspection.idMatches, 'INSPECTION_INCIDENT_SCOPE')
  const reply = await request(ROUTES.inspectionOccurrences)
  report.occurrenceInspection = inspectOccurrences(reply.data, reply.headers)
  report.result = 'inspected'
}

export function inspectOccurrences(rows, headers) {
  requireThat(Array.isArray(rows) && rows.length <= 5 && !/\bnext\b/i.test(headers.get('link') ?? ''), 'INSPECTION_OCCURRENCE_LIMIT')
  const integerOrNull = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  const legalPath = value => typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f\\:?#<>|"*]/.test(value)
    && value.split('/').every(part => part.length > 0 && part.length <= 255 && part !== '.' && part !== '..')
  return { noNextPage: true, returnedCount: rows.length, rows: rows.map(row => {
    requireThat(Array.isArray(row?.matches) && row.matches.length <= 32, 'INSPECTION_MATCH_LIMIT')
    const repoNumericMatches = row.source?.external_id === TARGET.repositoryId || row.source?.external_id === String(TARGET.repositoryId)
    let extraSource
    if (row.id === 296439688) {
      requireThat(row.incident_id === TARGET.incident && row.source?.id === 30134018 && row.source.type === 'github'
        && row.sha === '3367c154e0ebb5acde0cc22cca1a034c708a947f'
        && row.matches.length === 1 && row.matches[0]?.post_line_start === 7 && row.matches[0]?.post_line_end === 7,
      'INSPECTION_EXTRA_SOURCE_SCOPE')
      const fullName = row.source.full_name
      const [owner, repository, extraPart] = typeof fullName === 'string' ? fullName.split('/') : []
      const externalId = row.source.external_id
      const repositoryId = typeof externalId === 'number' ? externalId
        : typeof externalId === 'string' && /^[1-9][0-9]{0,15}$/.test(externalId) ? Number(externalId) : null
      requireThat(typeof owner === 'string' && owner.length <= 39 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) && !owner.includes('--')
        && typeof repository === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(repository) && !['.', '..'].includes(repository) && extraPart === undefined
        && typeof row.source.url === 'string' && row.source.url.toLowerCase() === `https://github.com/${fullName.toLowerCase()}`
        && positive(repositoryId) && legalPath(row.filepath), 'INSPECTION_EXTRA_SOURCE_FORMAT')
      extraSource = { repositoryFullName: fullName, githubUrl: row.source.url, repositoryId, filePath: row.filepath, line: 7 }
    }
    return {
      id: integerOrNull(row.id), incidentMatches: row.incident_id === TARGET.incident,
      repoNumericMatches,
      repoNameMatches: typeof row.source?.full_name === 'string' && row.source.full_name.toLowerCase() === TARGET.repository.toLowerCase(),
      sourceID: integerOrNull(row.source?.id),
      sha: typeof row.sha === 'string' && /^[a-f0-9]{40}$/i.test(row.sha) ? row.sha.toLowerCase() : null,
      filePath: repoNumericMatches && legalPath(row.filepath) ? row.filepath : null,
      changeType: ['addition', 'deletion'].includes(row.change_type) ? row.change_type : 'OTHER',
      matches: row.matches.map(match => ({
        preLineStart: integerOrNull(match?.pre_line_start), preLineEnd: integerOrNull(match?.pre_line_end),
        postLineStart: integerOrNull(match?.post_line_start), postLineEnd: integerOrNull(match?.post_line_end),
        ...(repoNumericMatches?{metadataFields:Object.keys(match).filter(k=>/^[a-z_]{1,40}$/.test(k)),indexStart:integerOrNull(match.indice_start),indexEnd:integerOrNull(match.indice_end)}:{}),
      })),
      ...(extraSource ? { extraSource } : {}),
    }
  }) }
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
    requireThat((method === 'GET' && [ROUTES.token, ROUTES.incident, ROUTES.occurrences, ROUTES.inspectionOccurrences].includes(route))
      || (method === 'POST' && [ROUTES.ignore, ROUTES.reopen].includes(route)), 'API_ROUTE')
    let response
    try {
      response = await fetcher(`${API}${route}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Token ${token}`, accept: 'application/json', 'content-type': 'application/json', 'x-privacy-mode': 'true' },
        ...(method === 'POST' && route === ROUTES.ignore ? { body: JSON.stringify({ ignore_reason: 'false_positive' }) } : {}),
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

export async function restoreCordy({ request, report }) {
  validateToken((await request(ROUTES.token)).data)
  const before = inspectIncident((await request(ROUTES.incident)).data)
  requireThat(before.idMatches && before.actualCount === 4 && before.urlExactMatches
    && before.detectorExactMatches, 'RESTORE_INCIDENT_SCOPE')
  const reply = await request(ROUTES.inspectionOccurrences)
  const occurrences = inspectOccurrences(reply.data, reply.headers)
  const rows = occurrences.rows
  const mikka = rows.filter(row => row.repoNumericMatches && row.repoNameMatches)
  requireThat(rows.length === 4 && mikka.length === 3
    && mikka.every(row => [310917415, 310917416, 310917417].includes(row.id)
      && row.incidentMatches && row.sha === TARGET.source && row.filePath === TARGET.file
      && row.matches.length === 1 && TARGET.lines.includes(row.matches[0].postLineStart))
    && rows.some(row => row.id === 296439688 && row.extraSource?.repositoryFullName === 'alexj11324/Cordy'), 'RESTORE_OCCURRENCE_SCOPE')
  report.before = before
  // Reopen the mixed incident; never ignore Cordy to make the Mikka check green.
  if (before.status === 'IGNORED') {
    report.writeAttempts = 1
    await request(ROUTES.reopen, 'POST')
  }
  const after = inspectIncident((await request(ROUTES.incident)).data)
  requireThat(after.idMatches && after.actualCount === 4 && after.urlExactMatches
    && ['TRIGGERED', 'ASSIGNED'].includes(after.status), 'RESTORE_READBACK')
  report.after = after
  report.result = 'mixed_incident_open'
}

export async function inspectScopedRules({ token, fetcher = fetch, report }) {
 const url = 'https://dashboard.gitguardian.com/api/v1/accounts/837165/secret-pattern-exclusions/'
 const r = await fetcher(url, { redirect:'error', signal:AbortSignal.timeout(15000), headers:{authorization:'Token '+token,accept:'application/json','x-privacy-mode':'true'} })
 report.scopedRuleApiStatus=r.status
 if(r.ok && r.headers.get('content-type')?.includes('application/json')) { const data=await r.json();report.scopedRuleArray=Array.isArray(data);report.scopedRuleCount=Array.isArray(data)?data.length:null }
 else await r.body?.cancel()
 report.result='scoped_rule_access_checked'
}

async function main() {
  const report = { incident: TARGET.incident, workspace: TARGET.workspace, result: 'blocked', writeAttempts: 0, requests: [],
    secretContentRequested: false, scannerConfigurationChanged: false, checkRunEditedOrSkipped: false }
  try {
    // This diagnostic revision deliberately has no CLI disposition entry point.
    requireThat(process.argv.length === 3 && ['--preflight', '--inspect', '--restore-cordy', '--scoped-rules'].includes(process.argv[2]), 'MODE')
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    report.execution = validateExecution({ env: process.env, event, head: git('rev-parse', 'HEAD'),
      parent: git('rev-parse', 'HEAD^'), changed: git('diff', '--name-only', 'HEAD^', 'HEAD').split('\n').filter(Boolean) })
    report.source = validateSource(execFileSync('git', ['show', `${TARGET.source}:${TARGET.file}`], { stdio: ['ignore', 'pipe', 'pipe'] }))
    if (process.argv[2] === '--preflight') report.result = 'source_verified'
    else if(process.argv[2]==='--scoped-rules') await inspectScopedRules({token:process.env.GITGUARDIAN_API_TOKEN,report})
    else await (process.argv[2] === '--restore-cordy' ? restoreCordy : inspect)({ request: guardianClient(process.env.GITGUARDIAN_API_TOKEN, fetch, row => report.requests.push(row)), report })
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
