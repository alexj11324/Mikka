import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { readWebAuthority } from '../release/cloudflare-promoted-web.mjs'

// The runtime that serves production owns its monitor. readWebAuthority reads
// the public DNS anchor and the production version response; a Vercel answer
// keeps the Vercel runtime checks, anything verified as Cloudflare retires
// them. No issue comment or milestone record decides this (Alex, 2026-11-16).
// The Neon/PostHog owner never changes here.
export async function runtimeMonitorOwner({fetchImpl=fetch,authority=readWebAuthority}={}){
  try {
    const origin=await authority(fetchImpl)
    if(origin.provider==='cloudflare')return {runtime:'cloudflare',product:origin.sha,reason:'serving_cloudflare'}
    return {runtime:'vercel',reason:'serving_vercel'}
  }catch{return {runtime:'vercel',reason:'authority_unreadable'}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await runtimeMonitorOwner()
  console.log('Runtime source: '+result.runtime+' ('+result.reason+')')
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'runtime='+result.runtime+'\n')
}
