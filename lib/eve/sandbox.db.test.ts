import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { SandboxSessionGoneError,type SandboxPrepareContext,type SandboxSessionContext,type SandboxConnection } from 'eve/sandbox/provider'
import { createPortableScratchProvider } from './sandbox'
import { scratchStore } from './sandbox-store'
import { scopeAuth,type EveScope } from './scope'
import { isE2eTarget,E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'

const url=process.env.E2E_DATABASE_URL
if(url)assert.ok(isE2eTarget(url),E2E_DB_RULE)
else if(process.env.REQUIRE_DB==='1')throw new Error('Portable sandbox tests require E2E_DATABASE_URL')
const text=(connection:SandboxConnection,path:string)=>connection.readFile({path}).then(bytes=>new TextDecoder().decode(bytes as Uint8Array))
async function command(connection:SandboxConnection,value:string) {
  const process=await connection.spawn({command:value,workingDirectory:'/workspace',env:{}})
  const [result,stdout,stderr]=await Promise.all([process.wait(),new Response(process.stdout).text(),new Response(process.stderr).text()])
  assert.equal(result.exitCode,0,stderr);return stdout
}
test('portable public provider prepares skills and persists attachments across replicas without idle PG leases',{skip:!url,timeout:30000},async()=>{
  const schema=`eve_sandbox_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url})
  await admin.query(`CREATE SCHEMA ${schema}`)
  const makePool=()=>new Pool({connectionString:url,options:`-c search_path=${schema},pg_catalog`,max:1})
  const pool=makePool(),replica=makePool()
  try {
    await pool.query('CREATE TABLE "user"(id text PRIMARY KEY);CREATE TABLE bots(id uuid PRIMARY KEY,owner_id text,workspace_id uuid)')
    await pool.query(await readFile(new URL('../../drizzle/20261112000400_eve_sandbox_sessions.sql',import.meta.url),'utf8'))
    const scope:EveScope={ownerId:'owner',botId:randomUUID(),workspaceId:randomUUID(),surface:'web'}
    await pool.query('INSERT INTO "user" VALUES($1)',[scope.ownerId]);await pool.query('INSERT INTO bots VALUES($1,$2,$3)',[scope.botId,scope.ownerId,scope.workspaceId])
    const store=(db:Pool)=>scratchStore(db,async(actual,tx)=>{
      if(!(await tx.query('SELECT 1 FROM bots WHERE id=$1 AND owner_id=$2 AND workspace_id=$3',[actual.botId,actual.ownerId,actual.workspaceId])).rowCount)throw Error('workspaceAccessDenied')
    })
    const provider=createPortableScratchProvider(async()=>store(pool))
    const prepare:SandboxPrepareContext={isEmpty:false,files:{list:async()=>[],read:async()=>new Uint8Array(),readText:async()=>''},storagePath:'/absent/build/cache',log:()=>{},resolveProjectPath:p=>'/absent/build/'+p,resourcesDirectory:async()=>undefined,templateKey:()=> 'portable-fixture',async populate(connection){
      await connection.writeFiles({files:[{path:'/workspace/seed.txt',content:new TextEncoder().encode('Prepared workspace\n')},{path:'/home/eve/.agents/skills/demo/SKILL.md',content:new TextEncoder().encode('# Prepared skill\n')}]})
      assert.equal(await command(connection,'cat seed.txt'),'Prepared workspace\n')
    }}
    const artifact=JSON.parse(JSON.stringify(await provider.prepare(prepare)))
    assert.equal(JSON.stringify(artifact).includes('/absent/build'),false)
    const ctx:SandboxSessionContext={session:{id:'native-session',auth:{current:scopeAuth(scope),initiator:scopeAuth(scope)},turn:{id:'turn',sequence:0}},kind:'session',storagePath:'/different/readonly/runtime',resolveProjectPath:p=>'/different/runtime/'+p}
    const opened=await provider.start(ctx,undefined,artifact)
    assert.equal(await text(opened.connection,'/workspace/seed.txt'),'Prepared workspace\n')
    assert.equal(await command(opened.connection,'cat "$HOME/.agents/skills/demo/SKILL.md"'),'# Prepared skill\n')
    const bytes=new Uint8Array([0,255,128,1,10])
    await opened.connection.writeFiles({files:[{path:'/workspace/attachment.bin',content:bytes}]})
    assert.equal(pool.idleCount,pool.totalCount,'an idle sandbox owns no pool connection')
    const nextProvider=createPortableScratchProvider(async()=>store(replica))
    const resumed=await nextProvider.resume(ctx,artifact,opened.state)
    assert.deepEqual(Array.from(await resumed.readFile({path:'/workspace/attachment.bin'}) as Uint8Array),Array.from(bytes))
    await Promise.all([command(opened.connection,'printf A >> counter.txt'),command(resumed,'printf B >> counter.txt')])
    const counter=await text(resumed,'/workspace/counter.txt')
    assert.ok(counter==='AB'||counter==='BA',counter)
    assert.equal(replica.idleCount,replica.totalCount)
    await assert.rejects(nextProvider.resume({...ctx,session:{...ctx.session,id:'foreign-session'}},artifact,opened.state),/workspaceAccessDenied/)
    await provider.onSessionEnd(ctx,opened.state,{reason:'completed'})
    await assert.rejects(nextProvider.resume(ctx,artifact,opened.state),error=>SandboxSessionGoneError.is(error))
    await provider.onSessionEnd(ctx,opened.state,{reason:'completed'})
    await opened.connection.close?.();await resumed.close?.()
  } finally {await pool.end();await replica.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()}
})
