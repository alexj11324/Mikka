export const AUDIENCE = 'mikka-engineering-sandbox'
export const REPOSITORY = 'alexj11324/Mikka'
export const WORKFLOW = REPOSITORY + '/.github/workflows/engineering-sandbox.yml@refs/heads/main'
export const DEADLINE_MS = 10 * 60_000
export const RECEIPT_MS = 7 * 24 * 60 * 60_000

export const sourceSuites = {
  'factory-handoff': [
    'scripts/dev-local/factory-handoff-acceptance.test.mjs',
    'scripts/dev-local/factory-handoff-acceptance.mjs',
    'scripts/dev-local/daemon-fault.mjs',
    'scripts/test-model-policy.mjs',
  ],
  'startup-timing': [
    'scripts/acceptance/cloud-startup-report.test.mjs',
    'scripts/acceptance/cloud-startup-report.mjs',
    'scripts/acceptance/cloud-startup.mjs',
    'scripts/acceptance/cloud-startup-evidence.mjs',
    'scripts/acceptance/eve-session.mjs',
    'scripts/acceptance/owned-codex-actor.mjs',
    'scripts/acceptance/team-workspace.mjs',
    'lib/smoke-account.ts',
    'lib/desktop-rpc/wire.ts',
  ],
}

export const jobs = {
  ...sourceSuites,
  'postgres-policy': ['drizzle/20261029011701_cli_run_policy.sql'],
}

export function githubRun(claims) {
  if (claims.repository !== REPOSITORY || claims.repository_id !== '1427517699' ||
      claims.workflow_ref !== WORKFLOW || claims.ref !== 'refs/heads/main' ||
      claims.sub !== 'repo:' + REPOSITORY + ':ref:refs/heads/main' ||
      !['workflow_dispatch', 'push'].includes(claims.event_name) ||
      !/^[1-9][0-9]{0,19}$/.test(claims.run_id) || !/^[1-9][0-9]{0,5}$/.test(claims.run_attempt)) return null
  return claims.run_id + '/' + claims.run_attempt
}

export function validJob(input) {
  return input && Object.hasOwn(jobs, input.workload) && /^[0-9a-f]{40}$/.test(input.sha) &&
    Number.isSafeInteger(input.issue) && input.issue > 0 && input.issue < 2 ** 31
}

export async function sourceFiles(job, fetchImpl = fetch) {
  return Promise.all(jobs[job.workload].map(async (path) => {
    const url = 'https://raw.githubusercontent.com/' + REPOSITORY + '/' + job.sha + '/' + path
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error('source HTTP ' + response.status + ' for ' + path)
    if (Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error('source exceeds limit: ' + path)
    if (!response.body) throw new Error('source body missing: ' + path)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0
    let text = ''
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > 1024 * 1024) throw new Error('source exceeds limit: ' + path)
      text += decoder.decode(chunk, { stream: true })
    }
    return { path, text: text + decoder.decode() }
  }))
}
