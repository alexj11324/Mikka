import { expect, it } from 'vitest'
import { readSubscriptionQuota } from '../src/subscription-quota'

for (const provider of ['codex','claude'] as const) {
 const body=()=>provider==='codex'?{credits:{has_credits:false,unlimited:false},rate_limit:{primary_window:{used_percent:20,limit_window_seconds:18000}}}:{extra_usage:{is_enabled:false},five_hour:{utilization:20}}
 it(`${provider} decodes credential-free worker quota metadata`,()=>{
  const quota=readSubscriptionQuota(provider,{status:200,body:body()});expect(quota.status).toBe('ok');expect(quota.windows[0]?.used).toBe(.2);expect(quota.source).toBe('official')
 })
 it(`${provider} refuses absent or enabled credit fallback`,()=>{
  for(const proof of [undefined,provider==='codex'?{has_credits:true,unlimited:false}:{is_enabled:true}]){
   const data:Record<string,unknown>=body();data[provider==='codex'?'credits':'extra_usage']=proof;expect(readSubscriptionQuota(provider,{status:200,body:data}).status).toBe('unknown')
  }
 })
 it(`${provider} handles denied and malformed responses without raw diagnostic output`,()=>{
  const result=readSubscriptionQuota(provider,{status:401,body:'fixture-private-diagnostic'});expect(result.status).toBe('unknown');expect(JSON.stringify(result)).not.toContain('fixture-private-diagnostic')
 })
}
