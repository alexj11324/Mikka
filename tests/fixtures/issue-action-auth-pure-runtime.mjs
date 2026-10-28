// Only this authentication unit test replaces the request-session boundary.
// Actual auth exports remain real; its DB-backed initialization is covered by
// the separate real-PG team suite and real-dependency offline import contract.
import './team-auth-runtime.mjs'
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier,context,next){
    const result=next(specifier,context)
    if(result.url.endsWith('/lib/session.ts'))return {url:'auth-pure:session',shortCircuit:true}
    if(result.url.endsWith('/lib/coordinator/wake.ts'))return {url:'auth-pure:wake',shortCircuit:true}
    return result
  },
  load(url,context,next){
    if(url==='auth-pure:wake')return {format:'module',source:'export async function wakeCoordinator(){throw new Error("unexpected coordinator dispatch in authentication test")}',shortCircuit:true}
    if(url==='auth-pure:session')return {format:'module',source:'export async function getSession(){return null}',shortCircuit:true}
    return next(url,context)
  },
})
