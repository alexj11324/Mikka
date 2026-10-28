// Transaction model only. The real scope store executes unchanged; this does
// not emulate PostgreSQL triggers or provide DB/concurrency acceptance.
import { registerHooks } from 'node:module'
import * as schema from '../../lib/db/schema.ts'
const rows = table => {
  const p=globalThis.scopeStoreProbe
  if(table===schema.issues)return [p.issue]
  if(table===schema.linearIssueLinks)return p.link?[{id:'link',remoteId:'remote'}]:[]
  if(table===schema.linearIssuePublications)return p.publication?[{id:'publication'}]:[]
  if(table===schema.linearSyncOutbox)return p.outgoing?[{id:'job',status:'failed'}]:[]
  throw Error('unexpected model table')
}
const tx={
  execute:async()=>{},
  select(){let table;const q={from(value){table=value;return q},where(){return q},limit(){return q},orderBy(){return q},for:async()=>rows(table),
    // oxlint-disable-next-line unicorn/no-thenable -- Match awaited Drizzle query builders.
    then(resolve,reject){return Promise.resolve(rows(table)).then(resolve,reject)}};return q},
  update(){let values;return {set(input){values=input;return this},where(){return this},async returning(){const p=globalThis.scopeStoreProbe;p.writes++;p.issue={...p.issue,...values};return [p.issue]}}},
  insert(){return {async values(){globalThis.scopeStoreProbe.versions++}}},
}
export const scopeStoreDatabase={transaction:async callback=>callback(tx)}
registerHooks({
  resolve(specifier,context,next){const r=next(specifier,context)
    if(r.url.endsWith('/lib/db/index.ts'))return {url:'scope-store:db',shortCircuit:true}
    if(r.url.endsWith('/lib/task-identifier-server.ts'))return {url:'scope-store:view',shortCircuit:true}
    return r},
  load(url,context,next){
    if(url==='scope-store:db')return {format:'module',source:`export {scopeStoreDatabase as db} from ${JSON.stringify(import.meta.url)}`,shortCircuit:true}
    if(url==='scope-store:view')return {format:'module',source:'export async function issueView(issue){return issue}',shortCircuit:true}
    return next(url,context)},
})
