import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { ORIGIN, REPOSITORY, successfulRelease } from './project-decisions.mjs'
import { webPublication } from './deployed-target.mjs'

const api = 'https://api.github.com/repos/' + REPOSITORY
const issuePath = '/issues/1966'
const workflow = '.github/workflows/task-attachment-production.yml'

function requireMatch(condition, reason) {
  if (!condition) throw new Error(reason)
}

export async function attachmentRelease(env, event, fetchImpl = fetch) {
  const sha = env.GITHUB_SHA
  const run = event.workflow_run
  requireMatch(env.GITHUB_EVENT_NAME === 'workflow_run' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_WORKFLOW_REF === REPOSITORY + '/' + workflow + '@refs/heads/main' &&
    event.action === 'completed' && event.repository?.full_name === REPOSITORY &&
    /^[0-9a-f]{40}$/.test(sha ?? '') && run?.event === 'push' && run.repository?.full_name === REPOSITORY &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
    successfulRelease([run], sha, 'web'), 'attachment_release_event_invalid')
  requireMatch(env.GH_TOKEN, 'attachment_release_metadata_credential_missing')

  const read = async (url, headers = {}) => {
    const response = await fetchImpl(url, {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/json', 'cache-control': 'no-store', ...headers },
    })
    requireMatch(response.ok, 'attachment_release_read_failed')
    return response.json()
  }
  const github = path => read(api + path, { authorization: 'Bearer ' + env.GH_TOKEN })
  const issueOpen = async () => {
    const issue = await github(issuePath)
    requireMatch(issue.number === 1966 && issue.url === api + issuePath && issue.repository_url === api &&
      !issue.pull_request && ['open', 'closed'].includes(issue.state), 'attachment_release_issue_invalid')
    return issue.state === 'open'
  }

  if (!await issueOpen()) return false
  // A green documentation-only Web deploy has no publication. The shared check
  // requires successful build, production upload and public-version verification.
  const publication = await webPublication({ github }, { applicationSha: sha, webDeployRunId: run.id })
  requireMatch(publication.webAttempt === run.run_attempt, 'attachment_release_attempt_changed')
  const ref = await github('/git/ref/heads/main')
  requireMatch(ref.ref === 'refs/heads/main' && ref.object?.type === 'commit' && ref.object.sha === sha,
    'attachment_release_main_changed')
  const version = await read(ORIGIN + '/mikka/api/version')
  requireMatch(version.build === sha, 'attachment_release_version_changed')
  return issueOpen()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const ready = await attachmentRelease(process.env, event)
    await appendFile(process.env.GITHUB_OUTPUT, 'ready=' + ready + '\n')
  } catch {
    console.error('Task attachment production release could not be verified')
    process.exitCode = 1
  }
}
