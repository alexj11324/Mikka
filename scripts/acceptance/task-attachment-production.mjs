import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createSessionClient, restoreAcceptanceWorkspace, selectAcceptanceTeam, smokeAcceptanceAccount } from './cloud-startup.mjs'

const origin = 'https://app.aspectlylabs.com'
const sha = value => createHash('sha256').update(value).digest('hex')
const jsonPost = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// #1593 trusted main run 42363177678, artifact 13570494196, report.json.
// ZIP sha256 e576acab17ba836b814bf56b4066b630d56fc6a413fd30497b4d2007b1de376b.
const historical = {
  owner: 'c4d6b5727534', team: 'fb00a1d8c63a0ae1c56ff3273bd259fd0756b8631b83e42f226926d389b3dade',
  source: 'e4494a3c8620d0ac8fe4cd885144a3f47be0252c',
  primary: { id: 'd9e95736-23ce-4283-a4e1-1848886a324e', caseId: '355bdc7f-127d-4e88-b897-08a5cf26fce3', harness: 'claude_code' },
}
class Refusal extends Error {}
function check(value, code) { if (!value) throw new Refusal(code) }

export function target(env) {
  const build = env.ATTACHMENT_EXPECTED_SHA
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'workflow_run'
    && /^[0-9a-f]{40}$/.test(build ?? '') && build === env.GITHUB_SHA
    && /^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9]\d{0,4}$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'target_refused')
  return { build, fixture: historical.primary, run: env.GITHUB_RUN_ID }
}
async function pin(client, build) {
  check((await client.json('/api/version')).build === build, 'build_changed')
}
function probeFor(run, taskId) {
  const seed = 'alexj11324/Mikka/1966/attachment/' + run + '/' + taskId
  const hex = sha('id:' + seed)
  const id = [hex.slice(0,8), hex.slice(8,12), '4' + hex.slice(13,16), '8' + hex.slice(17,20), hex.slice(20,32)].join('-')
  return { id, name: '1966-附件-' + sha('name:' + seed).slice(0,20) + '.txt',
    bytes: Buffer.from('Mikka attachment verification\n' + sha('body:' + seed) + '\n') }
}
function isOurMetadata(file, probe) {
  return file?.id === probe.id && file.name === probe.name && file.size === probe.bytes.length
}
async function confirmDownload(client, item, probe) {
  const response = await client.request(item)
  const disposition = "attachment; filename*=UTF-8''" + encodeURIComponent(probe.name)
  if (response.status !== 200 || response.headers.get('content-length') !== String(probe.bytes.length)
    || response.headers.get('content-disposition') !== disposition || response.headers.get('content-type') !== 'application/octet-stream') {
    await response.body?.cancel()
    throw new Refusal('file_unverified')
  }
  check(Buffer.from(await response.arrayBuffer()).equals(probe.bytes), 'file_unverified')
}

// Tests replace the transport only. Every request here uses the same scoped session.
export async function verifyFile(client, options, report, signal) {
  const listPath = '/api/tasks/' + options.fixture.id + '/attachments'
  const probe = probeFor(options.run, options.fixture.id)
  const item = listPath + '?id=' + probe.id
  const read = async () => {
    const list = await client.json(listPath)
    check(list.canEdit === true && Array.isArray(list.files), 'file_list_refused')
    const matches = list.files.filter(row => row?.id === probe.id)
    check(matches.length <= 1, 'file_unverified')
    return matches[0]
  }
  const before = await read()
  if (before) {
    check(isOurMetadata(before, probe), 'file_conflict')
    await confirmDownload(client, item, probe)
  }
  let proven = Boolean(before), attempted = false, uploadConfirmed = false
  try {
    check(!signal?.aborted, 'interrupted')
    await pin(client, options.build)
    check(!signal?.aborted, 'interrupted')
    if (!before) {
      const form = new FormData()
      form.append('file', new Blob([probe.bytes]), probe.name)
      attempted = true
      const response = await client.request(item, { method: 'POST', body: form })
      // A 409 explicitly denies ownership; a transport error may hide a commit.
      if (response.status === 409) { attempted = false; throw new Refusal('file_conflict') }
      check(response.status === 200 && isOurMetadata(await response.json(), probe), 'upload_unverified')
      uploadConfirmed = true
      proven = true
    }
    check(isOurMetadata(await read(), probe), 'file_unverified')
    await confirmDownload(client, item, probe)
    report.bytesMatched = true
    check(!signal?.aborted, 'interrupted')
  } finally {
    if (proven || attempted) {
      report.fileCleanup = 'unconfirmed'
      // Re-list and confirm the exact object after an ambiguous POST. Never
      // adopt another row, even on a same-name collision. A retry has the same ID.
      for (let i = 0; i < 2; i++) {
        try {
          const current = await read()
          if (current) {
            check(isOurMetadata(current, probe), 'file_conflict')
            // The product accepted our bytes for this unique, initially absent
            // ID. Storage read failures cannot prevent removal of that upload.
            // Recovered rows and ambiguous POST responses still need byte proof.
            if (!uploadConfirmed) await confirmDownload(client, item, probe)
            proven = true
            const deleted = await client.request(item, { method: 'DELETE' })
            check(deleted.status === 204 || deleted.status === 404, 'cleanup_unconfirmed')
            await deleted.body?.cancel()
          }
          const absent = await client.request(item)
          const status = absent.status
          await absent.body?.cancel()
          check(status === 404 && !await read(), 'cleanup_unconfirmed')
          // No positive observation after a lost POST cannot rule out a late commit.
          check(proven || !attempted, 'cleanup_unconfirmed')
          report.fileCleanup = 'confirmed_absent'
          break
        } catch { /* Retry readback after a lost DELETE without deleting other files. */ }
      }
    }
  }
}

export function scopeHashes(owner, team) {
  return { owner: sha('owner:' + owner).slice(0,12), team: sha('team-workspace\0' + team) }
}
export function checkTask(issue, options, owner, workspaceId) {
  const { id, caseId, harness } = options.fixture
  const marker = '案例 ' + caseId + '，发布源 ' + historical.source + '。'
  check(issue?.id === id && issue.userId === owner && issue.workspaceId === workspaceId && issue.ownershipState === 'bound'
    && !issue.content?.attrs?.mikka?.deletedAt && !issue.content?.attrs?.orvilo?.deletedAt
    && issue.title === '测试 1593 lifecycle review ' + caseId + ' ' + harness
    && issue.content?.type === 'doc' && issue.content.content?.some(p => p.type === 'paragraph'
      && p.content?.some(n => n.type === 'text' && typeof n.text === 'string' && n.text.includes(marker))), 'task_mismatch')
}
export async function accept({ env, client, signal, historicalScope = historical, selectTeam = selectAcceptanceTeam }) {
  const report = { issue: 1966, startedAt: new Date().toISOString(), status: 'failed', bytesMatched: false,
    fileCleanup: 'not_needed', workspaceRestored: null, signedOut: null, finalBuildMatched: false, cleanupFailures: [] }
  let phase = 'target', options, loginAttempted = false, original, owner
  try {
    options = target(env)
    report.applicationSha = options.build
    check(!signal?.aborted, 'interrupted')
    await pin(client, options.build)
    phase = 'login'
    const account = smokeAcceptanceAccount(env)
    loginAttempted = true
    check((await client.request('/api/auth/sign-in/email', jsonPost({ ...account, rememberMe: false }))).ok, 'login_refused')
    const { user } = await client.json('/api/auth/get-session?disableCookieCache=true')
    check(typeof user?.id === 'string' && user.email?.toLowerCase() === account.email.toLowerCase()
      && sha('owner:' + user.id).slice(0,12) === historicalScope.owner, 'identity_mismatch')
    owner = user.id
    phase = 'workspace'
    const scope = await selectTeam(client, { ownerId: owner }, id => { original = id })
    check(scopeHashes(owner, scope.workspaceId).team === historicalScope.team, 'team_mismatch')
    phase = 'task'
    const { issue } = await client.rpc('issues.getIssue', [options.fixture.id])
    checkTask(issue, options, owner, scope.workspaceId)
    phase = 'attachment'
    await verifyFile(client, options, report, signal)
  } catch (error) { report.failure = error instanceof Refusal ? error.message : phase + '_failed' }
  finally {
    if (original) {
      try { await restoreAcceptanceWorkspace(client, owner, original); report.workspaceRestored = true }
      catch { report.workspaceRestored = false }
    }
    if (loginAttempted) {
      try {
        const logout = await client.request('/api/auth/sign-out', jsonPost({}))
        report.signedOut = logout.status === 200 && await client.json('/api/auth/get-session?disableCookieCache=true') === null
      }
      catch { report.signedOut = false }
    }
    client.clear()
    if (options) {
      try { await pin(client, options.build); report.finalBuildMatched = true } catch { report.finalBuildMatched = false }
    }
    if (report.fileCleanup === 'unconfirmed') report.cleanupFailures.push('attachment')
    if (report.workspaceRestored === false) report.cleanupFailures.push('workspace_restore')
    if (report.signedOut === false) report.cleanupFailures.push('sign_out')
  }
  if (!report.failure && report.bytesMatched && report.fileCleanup === 'confirmed_absent'
    && report.workspaceRestored && report.signedOut && report.finalBuildMatched) report.status = 'passed'
  report.finishedAt = new Date().toISOString()
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    check(process.argv.length === 2, 'target_refused')
    const stop = new AbortController()
    process.once('SIGTERM', () => stop.abort())
    process.once('SIGINT', () => stop.abort())
    const report = await accept({ env: process.env, client: createSessionClient(origin), signal: stop.signal })
    await mkdir('production-task-attachment-report', { recursive: true, mode: 0o700 })
    await writeFile('production-task-attachment-report/report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log('Attachment acceptance ' + report.status)
    if (report.status !== 'passed') process.exitCode = 1
  } catch { console.error('Attachment acceptance failed.'); process.exitCode = 1 }
}
