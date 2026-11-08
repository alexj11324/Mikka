// One-off #1712 disposition, adapted from the approved #1415 workflow at 8779dab.
// No secret/content endpoints, scanner exclusions, check edits or history rewrites.
import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'alexj11324/Mikka'
const REPOSITORY_ID = 1427517699
const OWNER_ID = 183887963
const BRANCH = 'refs/heads/ops/issue1712-gitguardian-prefix-status'
const WORKSPACE_ID = 837165
const REVISION = 'df8a36f7db9cc72508b1ccea86514ac5c4c224cf'
const INCIDENTS = Object.freeze([39804367])
const SOURCE = Object.freeze({
  path: 'packages/protocol/src/task-secrets.ts',
  line: 9,
  sha256: '08afff55d72f47b158e71dfbfa6ddef88fdda6948d46cd46556ea5e8af20268a',
  lineSha256: 'b9907a76d56fa4e3a8e43c0c3b044e2351f7a13bdb530a77e3cd54f0b5e6d697',
  occurrenceId: 311114581,
})
const API = 'https://api.gitguardian.com/v1'
const STATES = new Set(['TRIGGERED', 'ASSIGNED', 'IGNORED', 'RESOLVED'])
const MAX_BYTES = 2 * 1024 * 1024

class DispositionError extends Error {
  constructor(code, cause) { super(code, cause === undefined ? undefined : { cause }); this.code = code }
}
function requireCondition(condition, code) {
  if (!condition) throw new DispositionError(code)
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }

async function readBounded(response) {
  const length = response.headers.get('content-length')
  requireCondition(length === null || (/^\d+$/.test(length) && Number(length) <= MAX_BYTES), 'GG_RESPONSE_SIZE')
  requireCondition(response.body !== null, 'GG_RESPONSE_BODY')
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    requireCondition(bytes <= MAX_BYTES, 'GG_RESPONSE_SIZE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function verifySourceEvidence(fetcher = fetch) {
  const read = async (path) => {
    const url = 'https://raw.githubusercontent.com/' + REPOSITORY + '/' + REVISION + '/' + path
    let response
    try {
      response = await fetcher(url, { redirect: 'error', credentials: 'omit',
        signal: AbortSignal.timeout(20_000), headers: { accept: 'text/plain' } })
    } catch (cause) { throw new DispositionError('GG_SOURCE_NETWORK', cause) }
    requireCondition(response.status === 200 && response.url === url, 'GG_SOURCE_HTTP')
    return readBounded(response)
  }
  const bytes = await read(SOURCE.path)
  requireCondition(digest(bytes) === SOURCE.sha256, 'GG_SOURCE_DIGEST')
  const line = bytes.toString('utf8').split(/\r?\n/)[SOURCE.line - 1]
  requireCondition(typeof line === 'string' && digest(line) === SOURCE.lineSha256, 'GG_EVIDENCE_BINDING')
  // This is the entire public format marker, with no sealed capability suffix.
  // It identifies token-shaped strings for masking; it cannot authenticate a request.
  const match = /^export const TASK_SECRET_CAPABILITY_PREFIX = '([^']+)'$/.exec(line)
  requireCondition(match !== null && match[1] === ['mikka', 'egress', 'v1.'].join('-') &&
    Buffer.byteLength(match[1], 'utf8') === 16, 'GG_PUBLIC_PREFIX')
  return { revision: REVISION, evidenceFile: SOURCE.path, evidenceSha256: SOURCE.sha256,
    evidenceLine: SOURCE.line, evidenceLineSha256: SOURCE.lineSha256,
    publicPrefixVerified: true, prefixBytes: 16, evidenceKind: 'public-capability-format-prefix-without-token' }
}

export function assessIncident(detail, occurrences, id, workspaceId) {
  requireCondition(workspaceId === WORKSPACE_ID && INCIDENTS.includes(id) && detail?.id === id && STATES.has(detail.status), 'GG_INCIDENT_IDENTITY')
  requireCondition(['TRIGGERED', 'ASSIGNED'].includes(detail.status) ||
    (detail.status === 'IGNORED' && detail.ignore_reason === 'false_positive'), 'GG_INCIDENT_STATE')
  let dashboard
  try { dashboard = new URL(detail.gitguardian_url) }
  catch (cause) { throw new DispositionError('GG_INCIDENT_WORKSPACE', cause) }
  requireCondition(dashboard.origin === 'https://dashboard.gitguardian.com' &&
    dashboard.pathname === '/workspace/' + workspaceId + '/incidents/' + id &&
    !dashboard.search && !dashboard.hash && !dashboard.username && !dashboard.password, 'GG_INCIDENT_WORKSPACE')
  requireCondition(Array.isArray(occurrences) && occurrences.length === 1 &&
    Number.isSafeInteger(detail.occurrences_count) &&
    detail.occurrences_count === occurrences.length, 'GG_OCCURRENCES_COMPLETE')
  const evidenceLines = new Set()
  for (const occurrence of occurrences) {
    let sourceUrl
    try { sourceUrl = new URL(occurrence.source?.url) }
    catch (cause) { throw new DispositionError('GG_OCCURRENCE_SOURCE', cause) }
    requireCondition(occurrence.id === SOURCE.occurrenceId && occurrence.incident_id === id && occurrence.source?.type === 'github' &&
      typeof occurrence.source.full_name === 'string' &&
      occurrence.source.full_name.toLowerCase() === REPOSITORY.toLowerCase() &&
      sourceUrl.origin === 'https://github.com' &&
      sourceUrl.pathname.toLowerCase() === '/' + REPOSITORY.toLowerCase() &&
      !sourceUrl.search && !sourceUrl.hash && !sourceUrl.username && !sourceUrl.password &&
      (occurrence.source.external_id === undefined || String(occurrence.source.external_id) === String(REPOSITORY_ID)),
      'GG_OCCURRENCE_SOURCE')
    requireCondition(occurrence.sha === REVISION && occurrence.filepath === SOURCE.path &&
      occurrence.change_type === 'addition', 'GG_OCCURRENCE_COMMIT_PATH')
    requireCondition(Array.isArray(occurrence.matches) && occurrence.matches.length > 0, 'GG_OCCURRENCE_MATCHES')
    const lines = new Set()
    for (const match of occurrence.matches) {
      requireCondition(Number.isSafeInteger(match.post_line_start) &&
        match.post_line_start === match.post_line_end &&
        match.post_line_start === SOURCE.line, 'GG_OCCURRENCE_LINE')
      lines.add(match.post_line_start)
    }
    requireCondition(lines.size === 1, 'GG_OCCURRENCE_LINE')
    evidenceLines.add([...lines][0])
  }
  requireCondition(evidenceLines.size === 1, 'GG_OCCURRENCE_LINE')
  return { id, occurrenceId: SOURCE.occurrenceId, beforeStatus: detail.status, evidenceLine: [...evidenceLines][0],
    occurrenceCount: occurrences.length, repositoryMatches: true, pathMatches: true,
    revisionMatches: true, workspaceMatches: true }
}

export async function guardWorkflow(env) {
  requireCondition(env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REPOSITORY === REPOSITORY &&
    env.GITHUB_REF === BRANCH && /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') &&
    env.GITHUB_ACTIONS === 'true', 'GG_WORKFLOW_SCOPE')
  let event
  try { event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')) }
  catch (cause) { throw new DispositionError('GG_EVENT_INVALID', cause) }
  requireCondition(event.ref === BRANCH && event.after === env.GITHUB_SHA && event.deleted === false &&
    event.repository?.full_name === REPOSITORY && event.repository.id === REPOSITORY_ID &&
    event.repository.owner?.id === OWNER_ID && event.repository.fork === false, 'GG_EVENT_SCOPE')
}

export async function disposeFalsePositives({ token, report, fetcher = fetch }) {
  const evidence = report?.sourceEvidence
  requireCondition(evidence?.revision === REVISION && evidence.evidenceFile === SOURCE.path &&
    evidence.evidenceSha256 === SOURCE.sha256 && evidence.evidenceLine === SOURCE.line &&
    evidence.evidenceLineSha256 === SOURCE.lineSha256 && evidence.publicPrefixVerified === true &&
    evidence.prefixBytes === 16 && evidence.evidenceKind === 'public-capability-format-prefix-without-token', 'GG_SOURCE_REQUIRED')
  requireCondition(typeof token === 'string' && token.length > 0 && token.length <= 16384 &&
    !/[\r\n]/.test(token), 'GG_TOKEN_MISSING')
  const request = async (operation, path, id, method = 'GET') => {
    const allowedGet = path === '/api_tokens/self' ||
      INCIDENTS.some(value => path === '/incidents/secrets/' + value ||
        path === '/occurrences/secrets?incident_id=' + value + '&per_page=100')
    const allowedPost = INCIDENTS.some(value => path === '/incidents/secrets/' + value + '/ignore')
    requireCondition((method === 'GET' && allowedGet) || (method === 'POST' && allowedPost), 'GG_REQUEST_SCOPE')
    const url = API + path
    let response
    try {
      response = await fetcher(url, { method, redirect: 'error', credentials: 'omit',
        signal: AbortSignal.timeout(20_000),
        headers: { authorization: 'Token ' + token, accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{"ignore_reason":"false_positive"}' } : {}),
      })
    } catch (cause) { throw new DispositionError('GG_API_NETWORK', cause) }
    report.requests.push({ operation, ...(id ? { incidentId: id } : {}), status: response.status })
    requireCondition(response.status === 200 && response.url === url, 'GG_API_HTTP')
    if (path.startsWith('/occurrences/')) {
      requireCondition(!/\brel\s*=\s*"?next"?/i.test(response.headers.get('link') ?? ''), 'GG_OCCURRENCES_PAGINATED')
    }
    let value
    try { value = JSON.parse((await readBounded(response)).toString('utf8')) }
    catch (error) {
      if (error instanceof DispositionError) throw error
      throw new DispositionError('GG_API_JSON', error)
    }
    return value
  }
  const self = await request('token-metadata', '/api_tokens/self')
  const canEdit = Array.isArray(self?.scopes) &&
    (self.scopes.includes('incidents:write') || self.scopes.includes('incidents:share'))
  report.token = { active: self?.status === 'active', canEditIncidents: canEdit }
  requireCondition(report.token.active && canEdit && self.workspace_id === WORKSPACE_ID, 'GG_TOKEN_PERMISSION')
  const assessments = []
  // Complete the one exact occurrence binding before the only permitted write.
  for (const id of INCIDENTS) {
    const detail = await request('incident-before', '/incidents/secrets/' + id, id)
    const occurrences = await request('occurrence-metadata', '/occurrences/secrets?incident_id=' + id + '&per_page=100', id)
    assessments.push(assessIncident(detail, occurrences, id, self.workspace_id))
  }
  requireCondition(assessments.length === 1 && assessments[0].occurrenceId === SOURCE.occurrenceId,
    'GG_INCIDENT_BINDING')
  report.incidents = assessments
  report.allBindingsVerifiedBeforeWrite = true
  for (const item of assessments) {
    if (item.beforeStatus !== 'IGNORED') {
      report.writeAttempts += 1
      await request('ignore-false-positive', '/incidents/secrets/' + item.id + '/ignore', item.id, 'POST')
      report.writeResponsesAccepted += 1
    }
    const after = await request('incident-after', '/incidents/secrets/' + item.id, item.id)
    requireCondition(after?.id === item.id && after.status === 'IGNORED' &&
      after.ignore_reason === 'false_positive', 'GG_DISPOSITION_NOT_CONFIRMED')
    item.afterStatus = 'IGNORED'
    item.ignoreReason = 'false_positive'
  }
}

async function main() {
  const report = { version: 1, operation: 'issue1712-exact-public-prefix-false-positive',
    repository: REPOSITORY, workspaceId: WORKSPACE_ID, branch: BRANCH, startedAt: new Date().toISOString(),
    result: 'failed', stage: 'workflow-scope', requests: [], incidents: [],
    writeAttempts: 0, writeResponsesAccepted: 0, allBindingsVerifiedBeforeWrite: false,
    scannerConfigurationChanged: false, checkRunSkipped: false, checkConclusionEdited: false,
    sourceEvidenceDeleted: false, gitHistoryRewritten: false, productionCredentialsChanged: false,
    rawSecretOrOccurrenceContentRequested: false, gitGuardianCheckResult: 'not-observed' }
  let token
  try {
    requireCondition(process.argv.length === 2, 'GG_ARGUMENTS_FORBIDDEN')
    await guardWorkflow(process.env)
    report.workflowRevision = process.env.GITHUB_SHA
    report.stage = 'source-evidence'
    report.sourceEvidence = await verifySourceEvidence()
    report.stage = 'incident-disposition'
    token = process.env.GITGUARDIAN_API_TOKEN
    delete process.env.GITGUARDIAN_API_TOKEN
    await disposeFalsePositives({ token, report })
    report.result = 'passed'
    report.stage = 'complete'
  } catch (error) {
    report.failure = error instanceof DispositionError ? error.code : 'GG_UNEXPECTED'
    process.exitCode = 1
  } finally {
    token = undefined
    delete process.env.GITGUARDIAN_API_TOKEN
    report.finishedAt = new Date().toISOString()
    try {
      if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, 'GITGUARDIAN_API_TOKEN=\n')
      const directory = resolve('gitguardian-status-report')
      await mkdir(directory, { mode: 0o700 })
      const stat = await lstat(directory)
      requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), 'GG_REPORT_DIRECTORY')
      await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 })
      console.log('GitGuardian exact incident disposition: ' + report.result +
        (report.failure ? ' (' + report.failure + ')' : ''))
    } catch {
      console.error('GG_REPORT_WRITE_FAILED')
      process.exitCode = 1
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === '--check') {
    try {
      await guardWorkflow(process.env)
      await verifySourceEvidence()
      console.log('GitGuardian exact public-prefix source guard: passed')
    } catch (error) {
      console.error(error instanceof DispositionError ? error.code : 'GG_UNEXPECTED')
      process.exitCode = 1
    }
  } else await main()
}

