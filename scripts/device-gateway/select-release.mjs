import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { readWebAuthority } from '../release/cloudflare-promoted-web.mjs'

const gatewayInputs = new Set([
  'lib/device-gateway-ticket.ts', 'lib/device-gateway-client.ts', 'lib/device-gateway-notify.ts',
  'lib/device-presence.ts', 'lib/device-presence-grant.ts', 'lib/builtin-gateway/config.ts', 'lib/edition.ts',
  'lib/live/events.ts', 'lib/live/presence.ts', 'lib/live/revocation.ts', 'lib/live/scope.ts',
  'lib/live/session-ticket.ts', 'packages/protocol/src/coded-error.ts',
])

export function affectsWorker(workload, path) {
  if (!['device', 'cron'].includes(workload)) throw Error('unknown_edge_workload')
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/.test(path)) return false
  const directory = workload === 'device' ? 'cloudflare/device-gateway/' : 'cloudflare/suggestions-cron/'
  return path.startsWith(directory + 'src/') || path === directory + 'wrangler.jsonc'
    || (workload === 'device' && gatewayInputs.has(path))
}

export async function selectRelease(workload, env = process.env, fetchImpl = fetch) {
  if (!['device', 'cron'].includes(workload) || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_REPOSITORY !== 'alexj11324/Mikka'
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw Error('reviewed_main_workflow_required')
  if (env.GITHUB_EVENT_NAME === 'push') {
    if (!/^[a-f0-9]{40}$/.test(env.RELEASE_BEFORE ?? '') || /^0+$/.test(env.RELEASE_BEFORE)) throw Error('unknown_push_base')
    const files = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', env.RELEASE_BEFORE, env.GITHUB_SHA], { encoding: 'utf8' })
    if (!files.split('\0').some(file => affectsWorker(workload, file))) return false
  }
  return (await readWebAuthority(fetchImpl)).provider === 'vercel'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const publish = await selectRelease(process.argv[2])
  appendFileSync(process.env.GITHUB_OUTPUT, 'publish=' + publish + '\n')
}
