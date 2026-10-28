// Source-only server-action isolation; all calls below are in-memory spies.
import { registerHooks } from 'node:module'
const sources = new Map([
  ['server-only', 'export {}'],
  ['next/headers', 'export async function headers(){return new Headers()} export async function cookies(){return {get(){return undefined},set(){}}}'],
  ['next/server', 'export function after(){throw new Error("unexpected background dispatch")}'],
  ['next-intl/server', 'export async function getLocale(){return "en"} export async function getTranslations(){return (key)=>key}'],
])
const files = new Map([
  ['/lib/acting-user.ts', 'export async function currentUser(){return {id:"owner",name:"Owner",email:"owner@example.invalid"}};export function actAs(_id,fn){return fn()}'],
  ['/lib/issue-access.ts', 'export async function requireUser(){return {id:"owner",name:"Owner",email:"owner@example.invalid"}};export async function requireIssueAccess(id){return {issue:{id,userId:globalThis.scopeActionProbe.issueOwner},user:{id:"owner"}}};export async function issueForUser(){return null}'],
  ['/lib/issue-scope-store.ts', 'export async function changeIssueScopeLocally(){globalThis.scopeActionProbe.writes++;return {error:"unexpected"}};export async function previewPersonalScope(){throw new Error("unexpected preview")}'],
  ['/lib/linear-sync/dispatch.ts', 'export function dispatchLinearIssueSync(){globalThis.scopeActionProbe.dispatch++};export function dispatchLinearWork(){}'],
  ['/lib/coordinator/wake.ts', 'export async function wakeCoordinator(){};export function coordinatorEnabled(){return false}'],
])
registerHooks({
  resolve(specifier, context, next) {
    if (sources.has(specifier)) return {url:`scope-fixture:${encodeURIComponent(sources.get(specifier))}`,shortCircuit:true}
    const resolved=next(specifier,context)
    for(const [suffix,code] of files) if(resolved.url.endsWith(suffix)) return {url:`scope-fixture:${encodeURIComponent(code)}`,shortCircuit:true}
    return resolved
  },
  load(url,context,next) {
    if(url.startsWith('scope-fixture:')) return {format:'module',source:decodeURIComponent(url.slice('scope-fixture:'.length)),shortCircuit:true}
    return next(url,context)
  },
})
