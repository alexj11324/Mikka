// The session-only fixture is also used by the real PG suite. Keep this
// additional isolation exclusive to authentication tests with no side effects.
import './team-auth-runtime.mjs'
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier,context,next){
    const result=next(specifier,context)
    if(result.url.endsWith('/lib/coordinator/wake.ts'))return {url:'auth-pure:wake',shortCircuit:true}
    return result
  },
  load(url,context,next){
    if(url==='auth-pure:wake')return {format:'module',source:'export async function wakeCoordinator(){throw new Error("unexpected coordinator dispatch in authentication test")}',shortCircuit:true}
    return next(url,context)
  },
})
