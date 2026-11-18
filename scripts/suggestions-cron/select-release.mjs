import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { affectsWorker } from '../device-gateway/select-release.mjs'
import { readWebAuthority } from '../release/cloudflare-promoted-web.mjs'

export async function selectCronRelease(env = process.env, fetchImpl = fetch) {
  if (!['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_REF !== 'refs/heads/main'
      || env.GITHUB_REPOSITORY !== 'alexj11324/Mikka' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw Error('reviewed_main_workflow_required')
  if (env.GITHUB_EVENT_NAME === 'push') {
    if (!/^[a-f0-9]{40}$/.test(env.RELEASE_BEFORE ?? '') || /^0+$/.test(env.RELEASE_BEFORE)) throw Error('unknown_push_base')
    const files = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', env.RELEASE_BEFORE, env.GITHUB_SHA], { encoding: 'utf8' })
    if (!files.split('\0').some(file => affectsWorker('cron', file))) return false
  }
  return (await readWebAuthority(fetchImpl)).provider === 'cloudflare'
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'publish=' + await selectCronRelease() + '\n')
}
