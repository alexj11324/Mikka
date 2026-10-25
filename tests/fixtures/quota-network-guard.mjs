// Test process only. Deny external egress while exercising real Next handlers.
// This is a failure sentinel, not a successful provider simulation.
import { appendFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
function allowed(value) {
  const url = new URL(value)
  if (['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return
  appendFileSync(process.env.QUOTA_NETWORK_EVIDENCE, JSON.stringify({ origin: url.origin, utc: new Date().toISOString() })+'\n')
  throw new Error('quota-test: external egress denied')
}
const originalFetch=globalThis.fetch
if(originalFetch)globalThis.fetch=(input,options)=>{allowed(typeof input==='string'||input instanceof URL?input:input.url);return originalFetch(input,options)}
for (const [module,protocol] of [[http,'http:'],[https,'https:']]) {
  const original=module.request
  module.request=function(input,...args){
    if(typeof input==='string'||input instanceof URL)allowed(input)
    else allowed(`${input.protocol??protocol}//${input.hostname??input.host??'localhost'}:${input.port??(protocol==='https:'?443:80)}`)
    return original.call(this,input,...args)
  }
}
syncBuiltinESMExports()
