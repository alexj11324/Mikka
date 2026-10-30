import { Pool } from 'pg'
import { readCi } from '../../../lib/github/ci/read'
import { verifyGitHubRepositoryAccess } from '../../../lib/github/run-pull-request'
import { pollActiveCi } from './ci-poller'
import { postgresCiPollAdapter } from './ci-poll-store'
import { deliverCiOutbox } from './ci-outbox'

/** Not enabled until the existing Worker has an approved, scoped GitHub
 * credential delivery and the CI webhook is cut over separately. */
export async function runCiScheduled(env:{HYPERDRIVE?:{connectionString:string};CI_POLL_ENABLED?:string;GITHUB_APP_ID?:string;GITHUB_APP_PRIVATE_KEY?:string;CRON_SECRET?:string;MIKKA_URL?:string}) {
  if (env.CI_POLL_ENABLED !== '1') return
  if (!env.HYPERDRIVE?.connectionString || !env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.CRON_SECRET || !env.MIKKA_URL) throw new Error('CI polling is not configured')
  const destination=new URL(env.MIKKA_URL)
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash) throw new Error('CI callback is invalid')
  const pool=new Pool({connectionString:env.HYPERDRIVE.connectionString,max:3})
  try {
    const deadline=Date.now()+50_000
    const adapter=postgresCiPollAdapter(pool,async (lease,signal)=>{
      if (!lease.binding) throw new Error('CI binding unavailable')
      const {remoteKey,installationId,repositoryId,githubAccountId,prNumber,branch}=lease.binding
      const fetcher:typeof fetch=(input,init)=>fetch(input,{...init,signal:init?.signal ? AbortSignal.any([signal,init.signal]) : signal})
      const access=await verifyGitHubRepositoryAccess({remoteKey,githubAccountId,env:{GITHUB_APP_ID:env.GITHUB_APP_ID,GITHUB_APP_PRIVATE_KEY:env.GITHUB_APP_PRIVATE_KEY},fetcher})
      if (access.installationId !== installationId || access.repositoryId !== repositoryId) throw new Error('CI access changed')
      return readCi({remoteKey,installationId,repositoryId,prNumber,branch},{GITHUB_APP_ID:env.GITHUB_APP_ID,GITHUB_APP_PRIVATE_KEY:env.GITHUB_APP_PRIVATE_KEY},fetcher,{deadline})
    })
    await pollActiveCi(adapter,{deadline,limit:2})
    await deliverCiOutbox(pool,async(item,signal)=>{
      const response=await fetch(`${env.MIKKA_URL!.replace(/\/+$/,'')}/api/cron/ci-final`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${env.CRON_SECRET}`,'content-type':'application/json'},body:JSON.stringify(item),signal})
      await response.body?.cancel()
      return response.ok
    },{deadline,limit:4})
  } finally { await pool.end() }
}
