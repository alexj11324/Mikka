// Dedicated synthetic schema on the explicit loopback fixture. Retained even
// on failure; Actions later owns the service-container lifecycle.
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Pool } from 'pg'
const target=process.env.CI_NATIVE_RETAINED_DATABASE_URL ?? (process.env.CI==='true' && process.env.GITHUB_ACTIONS==='true' ? process.env.E2E_DATABASE_URL : undefined)
if(!target)throw Error('isolated CI native database is required')
const url=new URL(target), actions=process.env.CI==='true'&&process.env.GITHUB_ACTIONS==='true'
if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.search||url.hash||(actions ? target!==process.env.E2E_DATABASE_URL||url.pathname!=='/mikka_e2e'||url.port!=='5432' : url.pathname!=='/mikka_ci_native'||!/^\d+$/.test(url.port)))throw Error('isolated loopback CI database required')
const admin=new Pool({connectionString:target}),schema=`ci_native_${randomUUID().replaceAll('-','')}`
await admin.query(`CREATE SCHEMA "${schema}"`)
const scoped=new URL(target);scoped.searchParams.set('options',`-c search_path=${schema}`)
const db=new Pool({connectionString:scoped.toString()})
await db.query(`CREATE TABLE issues(id uuid primary key,"userId" text not null,scope text not null,"scopeVersion" integer not null,content jsonb not null);
CREATE TABLE mikka_workspaces(id uuid primary key); CREATE TABLE mikka_workspace_members("workspaceId" uuid,"userId" text,status text,primary key("workspaceId","userId")); CREATE TABLE mikka_teams(id uuid primary key,"workspaceId" uuid not null); CREATE TABLE mikka_team_issues("issueId" uuid primary key,"workspaceId" uuid not null,"teamId" uuid not null);
CREATE TABLE byos_connections(id uuid primary key,"ownerId" text,"workspaceId" text,epoch bigint,state text); CREATE TABLE byos_bindings(id uuid primary key,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint,route text,"modelId" text,"createdAt" timestamptz); CREATE TABLE agent_runs(id uuid primary key,"userId" text,"deviceId" uuid,"issueId" uuid,"sessionId" text,"ciContinuation" jsonb,"agentId" uuid,"agentDefinition" jsonb,status text,"leaseExpiresAt" timestamptz,"stopRequestedAt" timestamptz); CREATE TABLE byos_native_runs("runId" uuid primary key,"bindingId" uuid);
CREATE TABLE ci_native_sessions("runId" uuid primary key,ciphertext bytea not null,"createdAt" timestamptz not null default now(),final boolean not null default false); CREATE TABLE ci_native_session_epochs("runId" uuid primary key,epoch uuid not null); CREATE TABLE github_ci_commit_claims("userId" text,"issueId" uuid,"remoteKey" text,"prNumber" int,head text,"runId" uuid,"claimedAt" timestamptz not null default now(),primary key("userId","issueId","remoteKey","prNumber",head));`)
await db.end();await admin.end()
console.log(`Retained CI native fixture schema: ${schema}`)
const args=process.argv.slice(2)
if(args.length!==4||args.some(x=>!['tests/ci-native-session.retained.test.ts','tests/ci-poll-store.retained.test.ts','tests/ci-budget.retained.test.ts','tests/ci-poll-attention.retained.test.ts'].includes(x)))throw Error('invalid CI native test inventory')
const run=spawnSync(process.execPath,['--experimental-test-module-mocks','--import','./tests/support/server-only.mjs','--import','tsx','--test',...args],{encoding:'utf8',env:{...process.env,CI_NATIVE_RETAINED_DATABASE_URL:scoped.toString()},maxBuffer:8*1024*1024})
process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');process.exitCode=run.status??1
