import { Pool } from 'pg'
import { budgetedCiFetch, checkCiBudget, CiBudgetDeferred } from '../../../lib/github/ci/budget'
import { readCi, readCiHead } from '../../../lib/github/ci/read'
import { pollActiveCi } from './ci-poller'
import { postgresCiPollAdapter } from './ci-poll-store'
import { deliverCiOutbox } from './ci-outbox'
import { acquireCiMembership } from '../../../lib/github/ci/authority'
import { scopedCiToken } from './ci-token-cache'
import { verifyScopedCiAccess } from './ci-github-access'
import { staticCiCache } from './ci-static-cache'

/** Not enabled until the existing Worker has an approved, scoped GitHub
 * credential delivery and the CI webhook is cut over separately. */
export async function runCiScheduled(env:{HYPERDRIVE?:{connectionString:string};CI_WORKSPACE_HYPERDRIVE?:{connectionString:string};CI_POLL_ENABLED?:string;CRON_SECRET?:string;MIKKA_URL?:string}) {
  if (env.CI_POLL_ENABLED !== '1') return
  if (!env.HYPERDRIVE?.connectionString || !env.CI_WORKSPACE_HYPERDRIVE?.connectionString || !env.CRON_SECRET || !env.MIKKA_URL) throw new Error('CI polling is not configured')
  const destination=new URL(env.MIKKA_URL)
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash) throw new Error('CI callback is invalid')
  const pool=new Pool({connectionString:env.HYPERDRIVE.connectionString,max:3})
  const workspace=new Pool({connectionString:env.CI_WORKSPACE_HYPERDRIVE.connectionString,max:3})
  try {
    const deadline=Date.now()+50_000
    const authorize=async (item:{issueId:string;userId:string;issueOwner:string;issueScope:string}) => acquireCiMembership(item.issueId,item.userId,item.issueOwner,workspace,item.issueScope==='workspace')
    const read=async (lease:import('./ci-poller').CiPollLease,signal:AbortSignal,fresh:boolean)=>{
      if (!lease.binding) throw new Error('CI binding unavailable')
      const {remoteKey,installationId,repositoryId,prNumber,branch}=lease.binding
      const fetcher=budgetedCiFetch(pool,(input,init)=>fetch(input,{...init,signal:init?.signal ? AbortSignal.any([signal,init.signal]) : signal}))
      const token=await scopedCiToken(pool,lease,env.CRON_SECRET!,async current=>{
        await checkCiBudget(pool)
        const response=await fetch(`${env.MIKKA_URL!.replace(/\/+$/,'')}/api/cron/ci-token`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${env.CRON_SECRET}`,'content-type':'application/json'},body:JSON.stringify({watchId:current.id,leaseId:current.token,generation:current.generation}),signal})
        if(response.status===429)throw new CiBudgetDeferred()
        if(!response.ok)throw new Error('CI token unavailable')
        return await response.json() as {token:string;expiresAt:string}
      })
      await verifyScopedCiAccess(lease,token,signal,fetcher)
      if(!fresh && lease.observation?.deliveredFingerprint){
        const current=await readCiHead({remoteKey,installationId,repositoryId,prNumber,branch},token,fetcher,signal)
        if(!current.open || current.head===lease.observation.head)return {...current,snapshot:{checks:[],statuses:[]},unchangedDelivered:true as const}
      }
      return readCi({remoteKey,installationId,repositoryId,prNumber,branch},{},fetcher,{deadline,scopedToken:token,...(fresh?{}:{staticCache:staticCiCache(pool,lease)})})
    }
    const base=postgresCiPollAdapter(pool,(lease,signal)=>read(lease,signal,false),async lease=>{if(!lease.binding)throw new Error('CI binding unavailable');return authorize(lease.binding)},(lease,signal)=>read(lease,signal,true))
    const adapter=base
    const polled=await pollActiveCi(adapter,{deadline:deadline-15_000,limit:12})
    if (polled.failed) console.error('CI polling watch failures', {failed:polled.failed,scanned:polled.scanned})
    const delivered=await deliverCiOutbox(pool,async(item,signal)=>{
      const response=await fetch(`${env.MIKKA_URL!.replace(/\/+$/,'')}/api/cron/ci-final`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${env.CRON_SECRET}`,'content-type':'application/json'},body:JSON.stringify(item),signal})
      await response.body?.cancel()
      return response.status===429 ? 'deferred' as const : response.ok
    },{deadline,limit:4,authorize})
    if (delivered.failed) console.error('CI polling delivery failures', {failed:delivered.failed})
  } finally { await pool.end(); await workspace.end() }
}
