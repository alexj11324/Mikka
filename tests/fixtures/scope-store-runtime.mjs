// Transaction model only. The real scope store executes unchanged; this does
// not emulate PostgreSQL triggers or provide DB/concurrency acceptance.
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { PgDialect } from 'drizzle-orm/pg-core'
import * as schema from '../../lib/db/schema.ts'
const dialect = new PgDialect()
const rows = (table, columns, condition) => {
  const p=globalThis.scopeStoreProbe
  if(table===schema.issues) {
    assert.ok(condition.params.includes(p.issue.id))
    if (!columns?.issue) return [p.issue]
    // issueForUser and issueVisibility stay real. Apply their bound-tenant
    // predicate instead of granting every synthetic App read access.
    assert.match(condition.sql, /"ownershipState"/)
    assert.ok(condition.params.includes('bound'))
    if (/\bfalse\b/.test(condition.sql)) return []
    assert.ok(condition.params.includes(p.workspace.id))
    return p.issue.ownershipState==='bound' && p.issue.workspaceId===p.workspace.id ? [{issue:p.issue}] : []
  }
  if(table===schema.linearIssueLinks)return p.link?[{id:'link',remoteId:'remote'}]:[]
  if(table===schema.linearIssuePublications)return p.publication?[{id:'publication'}]:[]
  if(table===schema.linearSyncOutbox)return p.outgoing?[{id:'job',status:'failed'}]:[]
  throw Error('unexpected model table')
}
const tx={
  execute:async()=>{},
  select(columns){let table,condition;const q={from(value){table=value;return q},where(value){condition=dialect.sqlToQuery(value);return q},limit(){return q},orderBy(){return q},for:async mode=>{
    assert.equal(mode,'update');globalThis.scopeStoreProbe.locks.push('issues');return rows(table,columns,condition)
  },
    // oxlint-disable-next-line unicorn/no-thenable -- Match awaited Drizzle query builders.
    then(resolve,reject){return Promise.resolve(rows(table,columns,condition)).then(resolve,reject)}};return q},
  update(){let values;return {set(input){values=input;return this},where(){return this},async returning(){const p=globalThis.scopeStoreProbe;p.writes++;p.issue={...p.issue,...values};return [p.issue]}}},
  insert(){return {async values(){globalThis.scopeStoreProbe.versions++}}},
}
export const scopeStoreDatabase={select:tx.select,transaction:async callback=>callback(tx)}
export const scopeStorePool={query(){throw Error('unexpected raw App query in scope store fixture')}}
function workspaceQuery() {
  let table,condition
  const query={
    from(value){table=value[Object.getOwnPropertySymbols(value).find(s=>s.description==='drizzle:Name')];return query},
    innerJoin(){return query},
    where(value){condition=dialect.sqlToQuery(value);return query},
    async orderBy(){
      const p=globalThis.scopeStoreProbe,userId=condition.params[0]
      assert.equal(table,'mikka_workspaces')
      assert.deepEqual(condition.params,[userId,'active','team','personal',userId])
      return p.activeMembers.has(userId)?[p.workspace]:[]
    },
    async for(mode){
      const p=globalThis.scopeStoreProbe
      assert.equal(mode,'share')
      if(table==='mikka_workspaces'){
        assert.deepEqual(condition.params,[p.workspace.id]);p.locks.push('workspaces');return [p.workspace]
      }
      assert.equal(table,'mikka_workspace_members')
      const userId=condition.params[1]
      assert.deepEqual(condition.params,[p.workspace.id,userId,'active']);p.locks.push('workspace_members')
      return p.activeMembers.has(userId)?[{id:userId}]:[]
    },
  }
  return query
}
export const scopeStoreWorkspaceDatabase={select:workspaceQuery,transaction:callback=>callback({select:workspaceQuery})}
registerHooks({
  resolve(specifier,context,next){const r=next(specifier,context)
    if(r.url.endsWith('/lib/db/index.ts'))return {url:'scope-store:db',shortCircuit:true}
    if(r.url.endsWith('/lib/workspace-db.ts'))return {url:'scope-store:workspace',shortCircuit:true}
    if(r.url.endsWith('/lib/acting-user.ts'))return {url:'scope-store:acting-user',shortCircuit:true}
    if(r.url.endsWith('/lib/task-identifier-server.ts'))return {url:'scope-store:view',shortCircuit:true}
    return r},
  load(url,context,next){
    if(url==='scope-store:db')return {format:'module',source:`export {scopeStoreDatabase as db,scopeStorePool as pool} from ${JSON.stringify(import.meta.url)}`,shortCircuit:true}
    if(url==='scope-store:workspace')return {format:'module',source:`export {scopeStoreWorkspaceDatabase as workspaceDb,scopeStorePool as workspacePool} from ${JSON.stringify(import.meta.url)}`,shortCircuit:true}
    if(url==='scope-store:acting-user')return {format:'module',source:'export async function currentUser(){throw Error("scope store already receives its authenticated actor")}',shortCircuit:true}
    if(url==='scope-store:view')return {format:'module',source:'export async function issueView(issue){return issue}',shortCircuit:true}
    return next(url,context)},
})
