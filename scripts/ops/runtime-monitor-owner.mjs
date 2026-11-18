import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { readWebAuthority } from '../release/cloudflare-promoted-web.mjs'

// Only a confirmed Cloudflare origin can own the Cloudflare runtime monitor.
// Unknown or legacy origins fail closed instead of selecting a retired collector.
export async function runtimeMonitorOwner({fetchImpl=fetch,authority=readWebAuthority}={}){
  const origin=await authority(fetchImpl)
  if(origin.provider!=='cloudflare')throw Error('cloudflare_runtime_not_serving')
  return {runtime:'cloudflare',product:origin.sha,reason:'serving_cloudflare'}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await runtimeMonitorOwner()
  console.log('Runtime source: '+result.runtime+' ('+result.reason+')')
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'runtime='+result.runtime+'\n')
}
