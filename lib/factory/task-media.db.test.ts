import 'next/dist/server/node-environment-baseline'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { Pool } from 'pg'
import { factory194Target } from '../../tests/helpers/factory194-target'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { createCapturePosters, type CapturePosterStorage } from '../captures/poster-store'
import { capturePosterBinary, renderCapturePoster } from '../captures/poster'
import { createCaptureDownloads } from '../captures/private-download'
import { createFactoryStore, type FactoryTask } from './store'
import { createFactoryHumanStore } from './human-store'
import { FactoryError } from './contract'
import { authorizeFactoryTaskCapture, readFactoryTaskMedia } from './task-media'

const execute = promisify(execFile)
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const url = process.env.E2E_DATABASE_URL
const allowed = Boolean(url && isE2eTarget(url) && process.env.DATABASE_URL === url && process.env.MIKKA_DATABASE_URL === url)
if (!allowed && process.env.REQUIRE_DB === '1') throw new Error('Task media tests require matching isolated loopback *_e2e databases')

test('task media uses real owner/task/run relations and private cached video covers', {skip:!allowed}, async t => {
  const config = factory194Target(url!,false)
  const admin = new Pool(config)
  const schema = `task_media_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const database = new Pool({...config,max:6,options:`-c search_path=${schema}`})
  const directory = await mkdtemp(join(tmpdir(),'task-media-db-'))
  t.after(async () => { await database.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await rm(directory,{recursive:true,force:true}) })
  await database.query(`
    CREATE TABLE accounts (id text PRIMARY KEY, writable boolean NOT NULL DEFAULT true);
    CREATE FUNCTION mikka_account_assert_writable(owner text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      PERFORM 1 FROM accounts WHERE id=owner AND writable FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'account_deletion_pending'; END IF;
    END $$;
    CREATE TABLE issues (id uuid PRIMARY KEY,"userId" text,scope text,"scopeVersion" integer,"workspaceId" uuid,"ownershipState" text);
    CREATE TABLE memberships ("userId" text,workspace uuid,active boolean);
    CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text);
    CREATE TABLE coordinator_events (id uuid PRIMARY KEY,"userId" text,kind text,"botId" uuid,"issueId" uuid);
    CREATE TABLE factory_tasks (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"botId" uuid,"sourceEventId" uuid,"scopeVersion" integer,"workspaceId" uuid);
    CREATE TABLE factory_attempts (id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid);
    CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"workspaceId" uuid);
    CREATE TABLE run_captures (id uuid PRIMARY KEY,"userId" text,"runId" uuid REFERENCES agent_runs ON DELETE CASCADE,"issueId" uuid,
      kind text,"contentType" text,source text,status text,title text,size integer,"durationMs" integer,"createdAt" timestamptz NOT NULL DEFAULT now(),
      sha256 text,"storageKey" text,"inlineContent" bytea);
  `)
  await database.query(await readFile(new URL('../../drizzle/20261109010002_capture_posters.sql',import.meta.url),'utf8'))
  const owner = 'media-owner', peer = 'media-peer', workspace = randomUUID(), otherWorkspace = randomUUID()
  const issueId = randomUUID(), otherIssue = randomUUID(), taskId = randomUUID(), otherTask = randomUUID(), botId = randomUUID(), sourceId = randomUUID()
  const runs = Array.from({length:5},()=>randomUUID())
  await database.query("INSERT INTO accounts(id) VALUES($1),($2)",[owner,peer])
  await database.query("INSERT INTO memberships VALUES($1,$2,true)",[owner,workspace])
  await database.query("INSERT INTO issues VALUES($1,$2,'workspace',1,$3,'bound'),($4,$5,'personal',1,$6,'bound')",[issueId,peer,workspace,otherIssue,owner,otherWorkspace])
  await database.query('INSERT INTO bots VALUES($1,$2)',[botId,owner])
  await database.query("INSERT INTO coordinator_events VALUES($1,$2,'user_message',$3,$4)",[sourceId,owner,botId,issueId])
  await database.query('INSERT INTO factory_tasks VALUES($1,$2,$3,$4,$5,1,$7),($6,$2,$3,$4,$5,1,$7)',[taskId,owner,issueId,botId,sourceId,otherTask,workspace])
  for (const [index,id] of runs.entries()) await database.query('INSERT INTO agent_runs VALUES($1,$2,$3,$4)',[id,index===4?peer:owner,index===3?otherIssue:issueId,index===3?otherWorkspace:workspace])
  for (const [task,run] of [[taskId,runs[0]],[taskId,runs[1]],[taskId,runs[0]],[otherTask,runs[2]],[taskId,runs[4]]])
    await database.query('INSERT INTO factory_attempts VALUES($1,$2,$3)',[randomUUID(),task,run])
  const store = createFactoryHumanStore(database,bot => createFactoryStore(database,async (user,issue,tx) =>
    (await tx.query(`SELECT 1 FROM issues i JOIN memberships m ON m.workspace=i."workspaceId" AND m."userId"=$1 AND m.active WHERE i.id=$2`,[user,issue])).rowCount === 1,bot))
  const task = (await database.query<FactoryTask>('SELECT * FROM factory_tasks WHERE id=$1',[taskId])).rows[0]
  const path = join(directory,'source.mp4')
  await execute(await capturePosterBinary(),['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=96x64:d=0.12','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',path],{timeout:15_000})
  const video = new Uint8Array(await readFile(path))
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])
  const capture = async (run: string, options: {owner?:string;issue?:string|null;kind?:'image'|'video';status?:string;inline?:boolean}={}) => {
    const id = randomUUID(), kind=options.kind??'image', bytes=kind==='video'?video:png, user=options.owner??owner
    await database.query(`INSERT INTO run_captures(id,"userId","runId","issueId",kind,"contentType",source,status,title,size,"durationMs",sha256,"storageKey","inlineContent")
      VALUES($1,$2,$3,$4,$5,$6,'local',$7,'Stored capture',$8,$9,$10,$11,$12)`,
    [id,user,run,options.issue===undefined?issueId:options.issue,kind,kind==='video'?'video/mp4':'image/png',options.status??'ready',bytes.length,kind==='video'?120:null,digest(bytes),`${user}/source/${id}`,options.inline===false?null:Buffer.from(bytes)])
    return id
  }
  const oldImage = await capture(runs[0]), videoId = await capture(runs[1],{kind:'video'}), legacyImage=await capture(runs[0],{issue:null})
  const unbound=await capture(runs[2]), wrongIssue=await capture(runs[0],{issue:otherIssue}), foreign=await capture(runs[4],{owner:peer})
  await capture(runs[1],{status:'uploading'})

  await t.test('all attempts include unreferenced and historical media once; unrelated runs, owners and inconsistent issues stay private',async()=>{
    const media=await readFactoryTaskMedia(database,task)
    assert.deepEqual(new Set(media.map(item=>item.captureId)),new Set([oldImage,videoId,legacyImage]))
    assert.equal(media.length,3,'duplicate attempts referencing one run do not duplicate its files')
    const item=media.find(item=>item.captureId===videoId)!
    assert.match(item.url,new RegExp(`/api/factory/tasks/${taskId}/media/${videoId}$`))
    assert.equal(item.posterUrl,`${item.url}/poster`)
    assert.equal(media.find(item=>item.captureId===oldImage)?.posterUrl,null)
    for(const id of [oldImage,videoId,legacyImage]) assert.deepEqual(await authorizeFactoryTaskCapture(database,store,owner,taskId,id),{ownerId:owner})
    for(const id of [unbound,wrongIssue,foreign,randomUUID()]) await assert.rejects(authorizeFactoryTaskCapture(database,store,owner,taskId,id),error=>error instanceof FactoryError&&error.code==='factoryNotFound')
    await assert.rejects(authorizeFactoryTaskCapture(database,store,peer,taskId,oldImage),error=>error instanceof FactoryError&&error.code==='factoryNotFound')
  })

  await t.test('detail authorization applies to media after workspace membership or source ownership changes',async()=>{
    for(const [change,undo,args] of [
      ["UPDATE memberships SET active=false WHERE workspace=$1","UPDATE memberships SET active=true WHERE workspace=$1",[workspace]],
      ["UPDATE coordinator_events SET \"userId\"='other' WHERE id=$1",'UPDATE coordinator_events SET "userId"=\'media-owner\' WHERE id=$1',[sourceId]],
    ] as const){
      await database.query(change,[...args])
      try { await assert.rejects(authorizeFactoryTaskCapture(database,store,owner,taskId,oldImage),error=>error instanceof FactoryError&&error.code==='factoryNotFound') }
      finally { await database.query(undo,[...args]) }
    }
  })

  await t.test('provider scope changes preserve the bound tenant, while unresolved run history remains private',async()=>{
    await database.query('UPDATE issues SET "scopeVersion"=2,scope=\'personal\' WHERE id=$1',[issueId])
    assert.deepEqual(await authorizeFactoryTaskCapture(database,store,owner,taskId,oldImage),{ownerId:owner})
    await database.query('UPDATE agent_runs SET "workspaceId"=NULL WHERE id=$1',[runs[0]])
    try {
      assert.ok(!(await readFactoryTaskMedia(database,task)).some(item=>item.captureId===oldImage||item.captureId===legacyImage))
      await assert.rejects(authorizeFactoryTaskCapture(database,store,owner,taskId,oldImage),{code:'factoryNotFound'})
    } finally { await database.query('UPDATE agent_runs SET "workspaceId"=$2 WHERE id=$1',[runs[0],workspace]) }
  })

  await t.test('original videos stream behind current Thread ACL; inline files keep byte ranges',async()=>{
    const id=await capture(runs[1],{kind:'video',inline:false}),reads:Array<{key:string;range:string|null}>=[]
    const read=createCaptureDownloads(database,async(key,request)=>{reads.push({key,range:request.headers.get('range')});return new Response(new Uint8Array([1,2]),{status:206,headers:{'content-range':'bytes 0-1/20','content-length':'2'}})})
    const request=new Request('https://app.example.invalid/media',{headers:{range:'bytes=0-1'}})
    const response=await read(request,owner,id)
    assert.equal(response?.status,206)
    assert.equal(response?.headers.get('cache-control'),'private, no-store')
    assert.equal(response?.headers.get('location'),null)
    assert.equal(response?.headers.get('content-range'),'bytes 0-1/20')
    assert.deepEqual(new Uint8Array(await response!.arrayBuffer()),new Uint8Array([1,2]))
    assert.deepEqual(reads,[{key:`${owner}/source/${id}`,range:'bytes=0-1'}])
    assert.equal(await read(request,peer,id),null)
    assert.equal(reads.length,1,'an unauthorized reader cannot open the object')
    const inlineResponse=await read(request,owner,oldImage)
    assert.equal(inlineResponse?.status,206)
    assert.deepEqual(new Uint8Array(await inlineResponse!.arrayBuffer()),new Uint8Array(png.subarray(0,2)))
  })

  const inline:CapturePosterStorage={kind:()=> 'inline',read:async()=>{throw new Error('inline fixture must not fetch')},write:async()=>{throw new Error('inline fixture must not upload')},remove:async()=>{throw new Error('inline fixture must not delete an object')}}
  await t.test('a real historical video gains one JPEG cover; repeated GETs use the immutable cache',async()=>{
    let rendered=0
    const read=createCapturePosters(database,inline,async(...args)=>{rendered++;return renderCapturePoster(...args)})
    const first=await read(owner,videoId)
    assert.equal(first?.contentType,'image/jpeg'); assert.ok(first!.bytes.length>100)
    assert.deepEqual((await read(owner,videoId))?.bytes,first?.bytes)
    assert.equal(rendered,1)
    assert.equal((await database.query('SELECT count(*)::int AS n FROM run_capture_posters WHERE "captureId"=$1',[videoId])).rows[0].n,1)
    assert.equal(await read(peer,videoId),null)
    assert.equal(await read(owner,oldImage),null)
    await database.query("UPDATE run_captures SET status='failed' WHERE id=$1",[videoId])
    assert.equal(await read(owner,videoId),null,'a cached cover cannot bypass current capture state')
    await database.query("UPDATE run_captures SET status='ready' WHERE id=$1",[videoId])
  })

  await t.test('concurrent object-backed renders keep exactly one private cache and cleanup only their own losing object',async()=>{
    const id=await capture(runs[1],{kind:'video',inline:false})
    const objects=new Map<string,Uint8Array<ArrayBuffer>>([[`${owner}/source/${id}`,video]])
    let renders=0, release!:()=>void
    const barrier=new Promise<void>(resolve=>{release=resolve})
    const storage:CapturePosterStorage={kind:()=> 'r2',read:async key=>{const bytes=objects.get(key);assert.ok(bytes);return bytes},write:async(key,bytes)=>{objects.set(key,bytes)},remove:async key=>{objects.delete(key)}}
    const read=createCapturePosters(database,storage,async(...args)=>{renders++;if(renders===2)release();await barrier;return renderCapturePoster(...args)})
    const [first,second]=await Promise.all([read(owner,id),read(owner,id)])
    assert.deepEqual(first?.bytes,second?.bytes)
    assert.equal(objects.size,2,'original plus one winning cover')
    assert.equal(renders,2)
    await read(owner,id)
    assert.equal(renders,2)
  })

  await t.test('a disappearing original or sealed account cannot acquire a late cover',async()=>{
    const vanished=await capture(runs[1],{kind:'video'})
    const read=createCapturePosters(database,inline,async(...args)=>{const bytes=await renderCapturePoster(...args);await database.query('DELETE FROM run_captures WHERE id=$1',[vanished]);return bytes})
    assert.equal(await read(owner,vanished),null)
    const sealed=await capture(runs[1],{kind:'video'})
    await database.query('UPDATE accounts SET writable=false WHERE id=$1',[owner])
    try { await assert.rejects(createCapturePosters(database,inline)(owner,sealed),/account_deletion_pending/) }
    finally { await database.query('UPDATE accounts SET writable=true WHERE id=$1',[owner]) }
    assert.equal((await database.query('SELECT count(*)::int AS n FROM run_capture_posters WHERE "captureId"=$1',[sealed])).rows[0].n,0)
  })

  await t.test('an uncertain object write cleans its unique key and leaves no cache row',async()=>{
    const id=await capture(runs[1],{kind:'video',inline:false}),objects=new Set<string>()
    const storage:CapturePosterStorage={kind:()=> 'r2',read:async()=>video,write:async key=>{objects.add(key);throw new Error('synthetic interrupted write')},remove:async key=>{objects.delete(key)}}
    await assert.rejects(createCapturePosters(database,storage)(owner,id),/synthetic interrupted write/)
    assert.equal(objects.size,0)
    assert.equal((await database.query('SELECT count(*)::int AS n FROM run_capture_posters WHERE "captureId"=$1',[id])).rows[0].n,0)
  })
})
