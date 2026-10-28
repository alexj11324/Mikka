// Only request context is replaced at import time. Real auth must load AFTER
// the suite selects its isolated app/workspace databases and bootstrap ack.
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier,context,next) {
    if(specifier==='next/headers') return {url:'team-auth-fixture:headers',shortCircuit:true}
    return next(specifier,context)
  },
  load(url,context,next) {
    if(url==='team-auth-fixture:headers') return {format:'module',source:'export async function headers(){return new Headers()} export async function cookies(){return {get(){return undefined},set(){}}}',shortCircuit:true}
    return next(url,context)
  },
})

// Preserve the real module, all endpoints and getSession metadata. This is a
// synthetic caller identity for task ACL tests, not a real sign-in/session test.
export function installTeamSessionFixture(auth) {
  const api=auth.api, descriptor=Object.getOwnPropertyDescriptor(api,'getSession')
  if(!descriptor||typeof descriptor.value!=='function'||(!descriptor.configurable&&!descriptor.writable))throw Error('real auth getSession contract changed')
  const getSession=async function () {
    const id=globalThis.teamCreateTestUser
    return id?{user:{id,name:'Synthetic',email:`${id}@example.invalid`}}:null
  }
  Object.defineProperties(getSession,Object.getOwnPropertyDescriptors(descriptor.value))
  Object.defineProperty(api,'getSession',{...descriptor,value:getSession})
  let restored=false
  return () => {if(!restored){restored=true;Object.defineProperty(api,'getSession',descriptor)}}
}
