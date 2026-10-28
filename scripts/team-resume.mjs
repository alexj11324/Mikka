// One known pair of retained, migrated, empty team DBs. No native pg imports.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {SCOPE_DATABASES,SCOPE_RETAINED_DATABASE,SCOPE_RETIRED_APPROVALS} from './scope-acceptance-policy.mjs'
export const teamHash=value=>createHash('sha256').update(value).digest('hex')
export const TEAM_DATABASES=Object.freeze([SCOPE_DATABASES.app,SCOPE_DATABASES.workspace])
export const TEAM_OIDS=Object.freeze(['68678','68679'])
export const TEAM_PRESERVED_SCOPES=[{name:SCOPE_RETAINED_DATABASE,oid:'65537',owner:'postgres',businessSqlAuthorized:false},{name:SCOPE_DATABASES.scope,oid:'67104',owner:'postgres',businessSqlAuthorized:false}]
// Fingerprint this explicit public schema/catalog scope, not physical database
// bytes or sequence last-values. All queries are read-only and source-pinned.
export const TEAM_CATALOG_QUERIES={
  relations:"select c.relname as name,c.relkind as kind,pg_get_userbyid(c.relowner) as owner,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.relacl::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','S','v','m','f') order by c.relname",
  columns:"select c.relname as \"table\",a.attname as name,a.attnum,format_type(a.atttypid,a.atttypmod) as \"type\",a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) as \"default\",co.collname as collation from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum left join pg_collation co on co.oid=a.attcollation where n.nspname='public' and c.relkind in ('r','p','v','m','f') and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum",
  constraints:"select t.relname as \"table\",c.conname as name,c.condeferrable,c.condeferred,c.convalidated,pg_get_constraintdef(c.oid) as definition from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public' order by t.relname,c.conname",
  indexes:"select tablename,indexname,indexdef from pg_indexes where schemaname='public' order by tablename,indexname",
  functions:"select p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,pg_get_userbyid(p.proowner) as owner,p.proacl::text,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p') order by p.proname,arguments",
  triggers:"select c.relname as \"table\",t.tgname as name,t.tgenabled,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname",
  sequences:"select c.relname as name,s.seqtypid::regtype::text as \"type\",s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname",
  views:"select c.relname as name,pg_get_viewdef(c.oid) as definition from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('v','m') order by c.relname",
  policies:"select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname",
  enums:"select t.typname,e.enumlabel,e.enumsortorder from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' order by t.typname,e.enumsortorder",
  extensions:"select e.extname,e.extversion,n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by e.extname",
}
export function verifyTeamResumeTargets(manifest) {
  if(manifest.mode!=='team-after-migrated-empty'||JSON.stringify(manifest.databases)!==JSON.stringify(TEAM_DATABASES)||manifest.approvalTransfer!==false)throw Error('team-only resume target/mode mismatch')
  if(JSON.stringify(manifest.preservedDatabases)!==JSON.stringify(TEAM_PRESERVED_SCOPES)||JSON.stringify(manifest.retiredApprovalIds)!==JSON.stringify(SCOPE_RETIRED_APPROVALS))throw Error('team-only preservation/approval mismatch')
  if(manifest.resume.states.length!==2)throw Error('team-only resume state inventory mismatch')
  for(const [i,state]of manifest.resume.states.entries()){
    if(state.database!==TEAM_DATABASES[i]||state.oid!==TEAM_OIDS[i]||state.owner!=='postgres')throw Error('team-only retained identity mismatch')
    if(state.counts.length!==[83,12][i]||state.counts.some(t=>t.rows!==(t.name==='schema_migrations'?[63,7][i]:0)))throw Error('team-only expected state is not empty')
  }
  if(JSON.stringify(manifest.resume.catalogQuerySha256)!==JSON.stringify(Object.fromEntries(Object.entries(TEAM_CATALOG_QUERIES).map(([key,sql])=>[key,teamHash(sql)]))))throw Error('team catalog query scope changed')
}
export function verifyTeamResumeMetadata(rows) {
  const expected=[...TEAM_PRESERVED_SCOPES.map(x=>({datname:x.name,oid:x.oid,owner:x.owner})),...TEAM_DATABASES.map((datname,i)=>({datname,oid:TEAM_OIDS[i],owner:'postgres'}))]
  if(rows.length!==expected.length||expected.some(x=>!rows.some(r=>r.datname===x.datname&&r.oid===x.oid&&r.owner===x.owner)))throw Error('team-only retained database metadata mismatch')
}
export function verifyTeamResumeEvidence(manifest,read=readFileSync) {
  verifyTeamResumeTargets(manifest)
  const evidence={}
  for(const file of manifest.resume.evidence){const bytes=read(file.path);if(teamHash(bytes)!==file.sha256)throw Error('team resume evidence hash mismatch');evidence[file.kind]=file.kind==='journal'?bytes.toString().trim().split('\n').map(line=>JSON.parse(line)):JSON.parse(bytes)}
  const {result,journal,predecessor,catalog}=evidence
  if(result.candidate!=='a15fc81d3a6ae4d4ac56965862c49fdeea99e8af'||result.manifestHash!==teamHash(read(manifest.resume.evidence.find(x=>x.kind==='predecessor').path))||result.pendingCount!==0||!result.failed||result.queryCounts.team!==3||result.queryCounts['team:migrate']!==155)throw Error('team resume predecessor state uncertain')
  for(const key of ['name','id','image','volume','role','address','adminDb'])if(typeof manifest.resource?.[key]!=='string'||manifest.resource[key]!==predecessor.resource[key])throw Error('team resume original resource binding mismatch')
  if(manifest.resource.mustAlreadyBeRunning!==true||Object.entries(catalog.resource).some(([key,value])=>manifest.resource[key]!==value))throw Error('team resume catalog resource binding mismatch')
  if(!catalog.passed||catalog.resource.id!==predecessor.resource.id)throw Error('team catalog capture resource/readonly outcome mismatch')
  if(JSON.stringify(predecessor.migrations)!==JSON.stringify(manifest.migrations))throw Error('team resume SQL source inventory changed')
  const receipts=new Map(journal.filter(x=>x.event==='query-result').map(x=>[x.id,x]))
  const attempts=journal.filter(x=>x.event==='query-attempt'&&x.id.startsWith('team:migrate:'))
  for(const file of manifest.migrations){const found=attempts.filter(x=>x.sqlSha256===(file.beforeCommitSha256??file.sha256));if(found.length!==1||!receipts.get(found[0].id)?.ok)throw Error('team lacks successful original initialization receipt')}
  for(const [i,state]of manifest.resume.states.entries()) {
    const snapshots=journal.filter(x=>x.event==='snapshot'&&x.database===state.database)
    if(snapshots.length!==2||snapshots.some(x=>x.counts.length!==[83,12][i]||x.counts.some(t=>t.rows!==(t.name==='schema_migrations'?[63,7][i]:0))))throw Error('team predecessor contains business fixtures')
    if(JSON.stringify(snapshots[0].counts)!==JSON.stringify(state.counts))throw Error('team historical/current table counts differ')
    if(!result.created.some(([name,oid])=>name===state.database&&oid===state.oid))throw Error('team original creation identity missing')
    const oldLedger=journal.filter(x=>x.event==='ledger-readback'&&x.database===state.database).at(-1)
    if(oldLedger?.sha256!==state.ledgerSha256||oldLedger.count!==[63,7][i])throw Error('team original ledger identity mismatch')
    const recorded=catalog.states[i]
    if(recorded.database!==state.database||recorded.identity.oid!==state.oid||recorded.identity.role!==state.owner||recorded.connections.length||teamHash(JSON.stringify(recorded.catalog))!==state.catalogSha256||JSON.stringify(recorded.counts)!==JSON.stringify(state.counts)||teamHash(JSON.stringify(recorded.ledger))!==state.ledgerSha256)throw Error('team readonly catalog evidence mismatch')
  }
  return manifest.resume.states
}
export function validateTeamResumeState(expected,actual) {
  if(actual.identity.database!==expected.database||actual.identity.oid!==expected.oid||actual.identity.role!==expected.owner)throw Error('team resume live identity changed')
  if(JSON.stringify(actual.counts)!==JSON.stringify(expected.counts)||actual.connections.length)throw Error('team resume live empty state or connection changed')
  if(teamHash(JSON.stringify(actual.ledger))!==expected.ledgerSha256||teamHash(JSON.stringify(actual.catalog))!==expected.catalogSha256)throw Error('team resume ledger/catalog changed')
  return {database:expected.database,oid:expected.oid,catalogSha256:expected.catalogSha256,ledgerSha256:expected.ledgerSha256,businessRows:0}
}
