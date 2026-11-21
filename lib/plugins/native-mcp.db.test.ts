import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { PersonalPluginStore } from './store'
import { createMcpSchema } from './contracts'
import { isE2eTarget, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(isE2eTarget(url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') throw new Error('Native MCP tests require E2E_DATABASE_URL')

test('native connection exports only the frozen authorized endpoints and encrypted STDIO environment', { skip: !url }, async () => {
  const schema = `native_mcp_${randomUUID().replaceAll('-','')}`
  const admin = new Pool({connectionString:url}), pool = new Pool({connectionString:url,options:`-c search_path=${schema}`})
  await admin.query(`CREATE SCHEMA ${schema}`)
  try {
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES('owner'),('other'); CREATE TABLE workspace_app_policies(app text)`)
    for (const migration of ['20261031040000_personal_plugins.sql','20261104003000_mcp_workspace_shares.sql','20261112030000_native_task_mcp.sql']) await pool.query(await readFile(new URL('../../drizzle/'+migration,import.meta.url),'utf8'))
    const store = new PersonalPluginStore(pool,{WORKSPACE_SECRETS_KEY:randomBytes(32).toString('hex')})
    const secret = `synthetic-${randomUUID()}`
    const native = await store.createMcp('owner',createMcpSchema.parse({name:'Local',transport:'stdio',command:'node',args:['server.js'],cwd:'/workspace/repo',env:{SERVICE_TOKEN:secret}}))
    const remote = await store.createMcp('owner',createMcpSchema.parse({name:'Remote',url:'https://mcp.acme.dev/rpc',headers:{Authorization:`Bearer ${secret}`,'X-Account':'test'}}))
    const authority = {requester:'owner',workspaceId:null,servers:[native,remote].map(s=>({id:s.id,name:s.name,revision:s.revision,ownerId:'owner',grantId:null}))}
    assert.ok(!JSON.stringify(await store.listMcp('owner')).includes(secret))
    assert.ok(!(await pool.query('SELECT ciphertext FROM personal_mcp_servers')).rows.some(row=>row.ciphertext.includes(secret)))
    const exported = await store.nativeMcpConnections('owner',authority)
    assert.deepEqual(exported[0],{name:`mcp_${native.id.replaceAll('-','')}`,transport:'stdio',command:'node',args:['server.js'],cwd:'/workspace/repo',env:{SERVICE_TOKEN:secret}})
    assert.deepEqual(exported[1],{name:`mcp_${remote.id.replaceAll('-','')}`,transport:'http',url:'https://mcp.acme.dev/rpc',headers:{Authorization:`Bearer ${secret}`,'X-Account':'test'}})
    await assert.rejects(store.nativeMcpConnections('other',authority),/mcpUnavailable/)
    await store.updateMcp('owner',{id:native.id,env:{SERVICE_TOKEN:'rotated'}})
    await assert.rejects(store.nativeMcpConnections('owner',authority),/mcpUnavailable/)
    const changed = await store.mcpConnection('owner',native.id)
    assert.ok(changed.native?.transport === 'stdio')
    assert.equal(changed.native.env.SERVICE_TOKEN,'rotated')
    await store.updateMcp('owner',{id:remote.id,enabled:false})
    await assert.rejects(store.mcpConnection('owner',remote.id),/mcpUnavailable/)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() }
})
