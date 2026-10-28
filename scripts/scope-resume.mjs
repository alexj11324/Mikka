// Explicit recovery of the one known empty scope DB; never a generic ledger repair.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { SCOPE_RETAINED_DATABASE } from './scope-acceptance-policy.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex')
export const normalizeScopeDdl=value=>value.toLowerCase().replaceAll('"','').replaceAll('public.','').replace(/\s+/g,' ').replace(/\s*([(),])\s*/g,'$1').replace(/;$/,'').trim()
export function scopeResumeSchema(migrations,read=readFileSync) {
  const functions={},triggers={}
  for(const file of migrations){
    const sql=read(file.path,'utf8')
    for(const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\([^)]*\)[\s\S]*?\bas\s+(\$[\w]*\$)([\s\S]*?)\2\s*;/gi))functions[match[1].replaceAll('"','').replace('public.','')]=hash(match[3])
    for(const match of sql.matchAll(/create\s+trigger\s+([\w"]+)[\s\S]*?execute\s+(?:function|procedure)\s+[\w."]+\s*\([^)]*\)\s*;/gi)){
      const table=/\bon\s+([\w."]+)/i.exec(match[0])[1].replaceAll('"','').replace('public.','')
      triggers[table+'/'+match[1].replaceAll('"','')]=normalizeScopeDdl(match[0])
    }
  }
  if(Object.keys(functions).length!==11||Object.keys(triggers).length!==16)throw Error('resume source schema inventory changed')
  return {functions,triggers,columns:{'issues/scopeVersion':{type:'int4',nullable:'NO',default:'1'},'issues/linearSyncBlocked':{type:'bool',nullable:'NO',default:'false'},'linear_issue_links/externalTargetVerified':{type:'bool',nullable:'NO',default:'false'},'linear_issue_links/publicationId':{type:'uuid',nullable:'YES',default:null},'linear_sync_outbox/scopeVersion':{type:'int4',nullable:'NO',default:'1'},'linear_sync_outbox/claimToken':{type:'uuid',nullable:'YES',default:null}}}
}
export function verifyScopeResumeEvidence(manifest,read=readFileSync) {
  if(manifest.mode!=='resume-scope-after-bootstrap')throw Error('explicit resume manifest required')
  const resume=manifest.resume
  if(resume.database!==SCOPE_RETAINED_DATABASE||resume.oid!=='65537'||resume.owner!=='postgres')throw Error('resume retained identity mismatch')
  const data={}
  for(const file of resume.evidence){const bytes=read(file.path);if(hash(bytes)!==file.sha256)throw Error('resume evidence hash mismatch');data[file.kind]=file.kind==='journal'?bytes.toString().trim().split('\n').map(line=>JSON.parse(line)):JSON.parse(bytes)}
  const {predecessor,result,readback,journal}=data
  if(predecessor.candidate!=='2da9834018a3a0aa0f4fc8b8c4fd965e4d51be39'||result.candidate!==predecessor.candidate||result.manifestHash!==resume.predecessorManifestSha256||result.pendingCount!==0||result.failed!==true||result.queryCounts.scope!==2||result.queryCounts['scope:migrate']!==155||Object.keys(result.queryCounts).length!==2)throw Error('resume predecessor execution mismatch')
  if(JSON.stringify(predecessor.migrations)!==JSON.stringify(manifest.migrations))throw Error('resume migration payload manifest changed')
  const snapshots=readback.snapshots
  if(readback.teamStageStarted||readback.fixtureMigrationReplays||readback.listenersStarted||readback.providerRequests||readback.remainingWorkerConnections.length||readback.targets.length!==1||readback.targets[0].oid!==resume.oid)throw Error('resume predecessor did more than bootstrap')
  if(snapshots.length!==2||snapshots.some(snapshot=>snapshot.tableCount!==94||snapshot.totalCommittedRows!==70||JSON.stringify(snapshot.nonemptyTables)!==JSON.stringify([{name:'schema_migrations',rows:70}])))throw Error('resume predecessor is not empty')
  const results=new Map(journal.filter(row=>row.event==='query-result').map(row=>[row.id,row]))
  const attempts=journal.filter(row=>row.event==='query-attempt'&&row.id.startsWith('scope:migrate:'))
  for(const file of manifest.migrations){const matches=attempts.filter(row=>row.sqlSha256===(file.beforeCommitSha256??file.sha256));if(matches.length!==1||!results.get(matches[0].id)?.ok)throw Error('resume lacks successful source execution evidence')}
  if(!journal.some(row=>row.event==='worker-finished'&&row.phase==='scope'&&row.mode==='migrate')||journal.some(row=>row.event==='query-result'&&!row.ok))throw Error('resume migration outcome is uncertain')
  return {tables:journal.find(row=>row.event==='snapshot'&&row.stage==='failure-readback').counts,ledgerHash:journal.find(row=>row.event==='ledger-readback').sha256}
}
export function validateScopeResumeState(resume,expected,actual) {
  if(actual.identity.database!==resume.database||actual.identity.role!==resume.owner||actual.identity.oid!==resume.oid)throw Error('resume live identity mismatch')
  if(JSON.stringify(actual.counts)!==JSON.stringify(expected.tables))throw Error('resume live table/empty-fixture state changed')
  if(actual.workerConnections.length)throw Error('resume has active workers')
  if(hash(JSON.stringify(actual.ledger))!==expected.ledgerHash)throw Error('resume live ledger differs')
  const functions=Object.fromEntries(actual.functions.map(row=>{
    if(row.language!=='plpgsql'||row.securityDefiner||row.arguments!==''||row.returns!=='trigger'||row.config!==null||row.volatility!=='v'||row.owner!=='postgres')throw Error('resume function attributes changed')
    return [row.name,hash(row.body)]
  }))
  const triggers=Object.fromEntries(actual.triggers.map(row=>{
    if(row.enabled!=='O')throw Error('resume trigger disabled or changed')
    return [row.table+'/'+row.name,normalizeScopeDdl(row.definition)]
  }))
  const sorted=value=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)))
  if(sorted(functions)!==sorted(resume.schema.functions)||sorted(triggers)!==sorted(resume.schema.triggers))throw Error('resume function/trigger schema mismatch')
  for(const [key,value]of Object.entries(resume.schema.columns)){
    const column=actual.columns.find(row=>row.table+'/'+row.name===key)
    if(!column||column.type!==value.type||column.nullable!==value.nullable||column.default!==value.default)throw Error('resume critical column changed')
  }
  if(!actual.constraints.some(row=>row.table==='linear_comment_links'&&normalizeScopeDdl(row.definition)==='foreign key(issuelinkid)references linear_issue_links(id)on delete cascade'))throw Error('resume comment cascade FK changed')
  return {oid:actual.identity.oid,catalogSha256:hash(JSON.stringify({functions:actual.functions,triggers:actual.triggers,columns:actual.columns,constraints:actual.constraints,indexes:actual.indexes})),tableCount:actual.counts.length,businessRows:0,ledgerRows:70}
}
export const SCOPE_RESUME_QUERIES={
  functions:"select p.proname as name,p.prosrc as body,l.lanname as language,p.prosecdef as \"securityDefiner\",pg_get_function_identity_arguments(p.oid) as arguments,p.prorettype::regtype::text as \"returns\",p.proconfig as config,p.provolatile as volatility,pg_get_userbyid(p.proowner) as owner from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname='public' and not exists(select 1 from pg_depend d where d.objid=p.oid and d.classid='pg_proc'::regclass and d.deptype='e') order by p.proname",
  triggers:"select c.relname as \"table\",t.tgname as name,t.tgenabled as enabled,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname",
  columns:"select table_name as \"table\",column_name as name,udt_name as type,is_nullable as nullable,column_default as \"default\" from information_schema.columns where table_schema='public' order by table_name,ordinal_position",
  constraints:"select t.relname as \"table\",c.conname as name,pg_get_constraintdef(c.oid) as definition from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public' order by t.relname,c.conname",
  indexes:"select tablename as \"table\",indexname as name,indexdef as definition from pg_indexes where schemaname='public' order by tablename,indexname",
}
