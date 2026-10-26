// Test-only session stand-in. No network or database access occurs in this loader.
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier,context,next) {
    if(specifier==='next/headers') return {url:'team-auth-fixture:headers',shortCircuit:true}
    const result=next(specifier,context)
    if(result.url.endsWith('/lib/auth.ts')) return {url:'team-auth-fixture:auth',shortCircuit:true}
    return result
  },
  load(url,context,next) {
    if(url==='team-auth-fixture:headers') return {format:'module',source:'export async function headers(){return new Headers()} export async function cookies(){return {get(){return undefined},set(){}}}',shortCircuit:true}
    if(url==='team-auth-fixture:auth') return {format:'module',source:'export const auth={api:{async getSession(){const id=globalThis.teamCreateTestUser;return id?{user:{id,name:"Synthetic",email:`${id}@example.invalid`}}:null}}}',shortCircuit:true}
    return next(url,context)
  },
})
