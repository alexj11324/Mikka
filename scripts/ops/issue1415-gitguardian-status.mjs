import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'alexj11324/Mikka'
const REPOSITORY_ID = 1427517699
const OWNER_ID = 183887963
const BRANCH = 'refs/heads/ops/issue1415-gitguardian-status'
const REVISION = '7973afa9ad8cd3aaaaca0e5a12c05e3de8fd791d'
const EVIDENCE = 'docs/acceptance/issue-1415/hydration-and-harness-regressions.json'
const INCIDENTS = Object.freeze([39721795, 39721796])
const SOURCES = Object.freeze([
  { path: 'components/authenticated-read-cache.tsx', line: 7, sha256: '8a37c05d9473e5fc47f7f0b1188122e1aa014902841fc4e0575e2b55a94d3d48' },
  { path: 'apps/desktop/test/native-auth-diagnostics.mjs', line: 14, sha256: '0a422c9d337ba3507f6e6eb2825163ca6a6e860fcb96e9d45165da45ff7b85ea' },
])
const API = 'https://api.gitguardian.com/v1'
const STATES = new Set(['TRIGGERED', 'ASSIGNED', 'IGNORED', 'RESOLVED'])
const MAX_BYTES = 2 * 1024 * 1024

class DispositionError extends Error {
  constructor(code) { super(code); this.code = code }
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
    } catch { throw new DispositionError('GG_SOURCE_NETWORK') }
    requireCondition(response.status === 200 && response.url === url, 'GG_SOURCE_HTTP')
    return readBounded(response)
  }
  const evidenceBytes = await read(EVIDENCE)
  let evidence
  try { evidence = JSON.parse(evidenceBytes.toString('utf8')) }
  catch { throw new DispositionError('GG_SOURCE_JSON') }
  const lines = evidenceBytes.toString('utf8').split(/\r?\n/)
  const verified = []
  for (const source of SOURCES) {
    requireCondition(evidence.files?.[source.path] === source.sha256 &&
      lines[source.line - 1]?.includes(JSON.stringify(source.path) + ': ' + JSON.stringify(source.sha256)),
      'GG_EVIDENCE_BINDING')
    const bytes = await read(source.path)
    requireCondition(digest(bytes) === source.sha256, 'GG_SOURCE_DIGEST')
    verified.push({ path: source.path, evidenceLine: source.line,
      sha256: source.sha256, matchesEvidenceDigest: true })
  }
  return { revision: REVISION, evidenceFile: EVIDENCE,
    evidenceSha256: digest(evidenceBytes), files: verified }
}

export function assessIncident(detail, occurrences, id, workspaceId) {
  requireCondition(INCIDENTS.includes(id) && detail?.id === id && STATES.has(detail.status), 'GG_INCIDENT_IDENTITY')
  requireCondition(['TRIGGERED', 'ASSIGNED'].includes(detail.status) ||
    (detail.status === 'IGNORED' && detail.ignore_reason === 'false_positive'), 'GG_INCIDENT_STATE')
  let dashboard
  try { dashboard = new URL(detail.gitguardian_url) }
  catch { throw new DispositionError('GG_INCIDENT_WORKSPACE') }
  requireCondition(dashboard.origin === 'https://dashboard.gitguardian.com' &&
    dashboard.pathname === '/workspace/' + workspaceId + '/incidents/' + id &&
    !dashboard.search && !dashboard.hash && !dashboard.username && !dashboard.password, 'GG_INCIDENT_WORKSPACE')
  requireCondition(Array.isArray(occurrences) && occurrences.length > 0 && occurrences.length <= 100 &&
    Number.isSafeInteger(detail.occurrences_count) &&
    detail.occurrences_count === occurrences.length, 'GG_OCCURRENCES_COMPLETE')
  const evidenceLines = new Set()
  for (const occurrence of occurrences) {
    let sourceUrl
    try { sourceUrl = new URL(occurrence.source?.url) }
    catch { throw new DispositionError('GG_OCCURRENCE_SOURCE') }
    requireCondition(occurrence.incident_id === id && occurrence.source?.type === 'github' &&
      typeof occurrence.source.full_name === 'string' &&
      occurrence.source.full_name.toLowerCase() === REPOSITORY.toLowerCase() &&
      sourceUrl.origin === 'https://github.com' &&
      sourceUrl.pathname.toLowerCase() === '/' + REPOSITORY.toLowerCase() &&
      !sourceUrl.search && !sourceUrl.hash && !sourceUrl.username && !sourceUrl.password &&
      (occurrence.source.external_id === undefined || String(occurrence.source.external_id) === String(REPOSITORY_ID)),
      'GG_OCCURRENCE_SOURCE')
    requireCondition(occurrence.sha === REVISION && occurrence.filepath === EVIDENCE &&
      occurrence.change_type === 'addition', 'GG_OCCURRENCE_COMMIT_PATH')
    requireCondition(Array.isArray(occurrence.matches) && occurrence.matches.length > 0, 'GG_OCCURRENCE_MATCHES')
    const lines = new Set()
    for (const match of occurrence.matches) {
      requireCondition(Number.isSafeInteger(match.post_line_start) &&
        match.post_line_start === match.post_line_end &&
        SOURCES.some(source => source.line === match.post_line_start), 'GG_OCCURRENCE_LINE')
      lines.add(match.post_line_start)
    }
    requireCondition(lines.size === 1, 'GG_OCCURRENCE_LINE')
    evidenceLines.add([...lines][0])
  }
  requireCondition(evidenceLines.size === 1, 'GG_OCCURRENCE_LINE')
  return { id, beforeStatus: detail.status, evidenceLine: [...evidenceLines][0],
    occurrenceCount: occurrences.length, repositoryMatches: true, pathMatches: true,
    revisionMatches: true, workspaceMatches: true }
}

async function guardWorkflow(env) {
  requireCondition(env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REPOSITORY === REPOSITORY &&
    env.GITHUB_REF === BRANCH && /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') &&
    env.GITHUB_ACTIONS === 'true', 'GG_WORKFLOW_SCOPE')
  let event
  try { event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')) }
  catch { throw new DispositionError('GG_EVENT_INVALID') }
  requireCondition(event.ref === BRANCH && event.after === env.GITHUB_SHA && event.deleted === false &&
    event.repository?.full_name === REPOSITORY && event.repository.id === REPOSITORY_ID &&
    event.repository.owner?.id === OWNER_ID && event.repository.fork === false, 'GG_EVENT_SCOPE')
}

export async function disposeFalsePositives({ token, report, fetcher = fetch }) {
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
    } catch { throw new DispositionError('GG_API_NETWORK') }
    report.requests.push({ operation, ...(id ? { incidentId: id } : {}), status: response.status })
    requireCondition(response.status === 200 && response.url === url, 'GG_API_HTTP')
    if (path.startsWith('/occurrences/')) {
      requireCondition(!/\brel\s*=\s*"?next"?/i.test(response.headers.get('link') ?? ''), 'GG_OCCURRENCES_PAGINATED')
    }
    let value
    try { value = JSON.parse((await readBounded(response)).toString('utf8')) }
    catch (error) {
      if (error instanceof DispositionError) throw error
      throw new DispositionError('GG_API_JSON')
    }
    return value
  }
  const self = await request('token-metadata', '/api_tokens/self')
  const canEdit = Array.isArray(self?.scopes) &&
    (self.scopes.includes('incidents:write') || self.scopes.includes('incidents:share'))
  report.token = { active: self?.status === 'active', canEditIncidents: canEdit }
  requireCondition(report.token.active && canEdit && Number.isSafeInteger(self.workspace_id) &&
    self.workspace_id > 0, 'GG_TOKEN_PERMISSION')
  const assessments = []
  // Complete both evidence bindings before the first write.
  for (const id of INCIDENTS) {
    const detail = await request('incident-before', '/incidents/secrets/' + id, id)
    const occurrences = await request('occurrence-metadata', '/occurrences/secrets?incident_id=' + id + '&per_page=100', id)
    assessments.push(assessIncident(detail, occurrences, id, self.workspace_id))
  }
  requireCondition(new Set(assessments.map(item => item.evidenceLine)).size === SOURCES.length, 'GG_INCIDENT_PAIR')
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
  const report = { version: 1, operation: 'issue1415-exact-source-checksum-false-positives',
    repository: REPOSITORY, branch: BRANCH, startedAt: new Date().toISOString(),
    result: 'failed', stage: 'workflow-scope', requests: [], incidents: [],
    writeAttempts: 0, writeResponsesAccepted: 0, allBindingsVerifiedBeforeWrite: false,
    scannerConfigurationChanged: false, checkRunSkipped: false, sourceEvidenceDeleted: false,
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
