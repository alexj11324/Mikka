import test from 'node:test'
import assert from 'node:assert/strict'
import {inventoryFactoryEffects} from './factory-effects.mjs'
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const schema=prefix=>`${prefix}_${'a'.repeat(32)}`
function fixture({profile='factory_192',edges=[],data,pk={},isolation='repeatable read',readOnly='on'}={}){
 const ns=schema(profile),rootTables={factory_192:['agents'],monitor_195:['agent_runs','issues'],questions:['agent_runs']}[profile]
 data??=Object.fromEntries(rootTables.map((t,i)=>[t,[{id:id(i+1),privateText:'must-not-be-output'}]]))
 const roots=rootTables.map(t=>({table:t,pk:{id:data[t][0].id}}))
 const fixtureRows=Object.entries(data).flatMap(([table,rows])=>rows.map(row=>({table,pk:Object.fromEntries((pk[table]??['id']).map(c=>[c,row[c]]))})))
 const constraints=edges.map((e,i)=>({child_schema:ns,parent_schema:ns,name:`fk_${i}`,null_columns:null,...e}))
 const queries=[]
 const db={async query(sql,args){
  queries.push({sql,args});assert.match(sql,/^SELECT/);assert.doesNotMatch(sql,/\b(?:DELETE|DROP|UPDATE|INSERT|TRUNCATE|BEGIN|COMMIT)\b/)
  if(sql.includes('transaction_read_only'))return {rows:[{read_only:readOnly,isolation}]}
  if(sql.includes('AS table_name'))return {rows:Object.keys(data).map(table_name=>({table_name,pk_columns:pk[table_name]??['id'],not_null_columns:pk[table_name]??['id']}))}
  if(sql.includes('AS child_schema')){assert.match(sql,/sn\.nspname=\$1 OR dn\.nspname=\$1/);return {rows:constraints}}
  const table=/FROM "[^"]+"\."([^"]+)"/.exec(sql)?.[1];assert.ok(table)
  const columns=[...sql.matchAll(/"([^"]+)"=\$(\d+)/g)]
  const found=data[table].filter(row=>columns.every(([,column,index])=>row[column]===args[Number(index)-1]))
  return {rows:found.map(row=>({row:{...row}}))}
 }}
 return {db,queries,options:{schema:ns,roots,fixtureRows,maxRows:fixtureRows.length},data,constraints}
}
const edge=(parent,child,parent_columns,child_columns,action='c',extra={})=>({parent,child,parent_columns,child_columns,action,...extra})

test('each isolated schema uses its actual root contract and SELECT-only snapshot',async()=>{
 for(const profile of ['factory_192','monitor_195','questions']){
  const f=fixture({profile});const r=await inventoryFactoryEffects(f.db,f.options)
  assert.equal(r.count,profile==='monitor_195'?2:1);assert.equal(r.executedDeletion,false)
  assert.ok(r.effects.every(e=>/^[a-f0-9]{64}$/.test(e.rowHash)))
  assert.ok(!JSON.stringify(r).includes('must-not-be-output'))
 }
})

test('composite primary keys and multi-column FK cascades are registered exactly',async()=>{
 const f=fixture({data:{agents:[{id:id(1)}],factory_tasks:[{id:id(2),agentId:id(1)}],factory_events:[{taskId:id(2),eventId:id(3),payload:'private'}],leaf:[{id:id(4),taskId:id(2),eventId:id(3)}]},pk:{factory_events:['taskId','eventId']},edges:[edge('agents','factory_tasks',['id'],['agentId']),edge('factory_tasks','factory_events',['id'],['taskId']),edge('factory_events','leaf',['taskId','eventId'],['taskId','eventId'])]})
 const r=await inventoryFactoryEffects(f.db,f.options)
 assert.equal(r.count,4);assert.ok(r.effects.every(e=>e.effect==='delete'))
 assert.deepEqual(r.effects.find(e=>e.table==='factory_events').pk,{taskId:id(2),eventId:id(3)})
 assert.ok(!JSON.stringify(r).includes('private'))
 assert.ok(f.queries.some(q=>q.sql.includes('WHERE "taskId"=$1 AND "eventId"=$2 LIMIT 2')))
})

test('SET NULL merges multiple FK columns on one registered row',async()=>{
 const f=fixture({profile:'monitor_195',data:{agent_runs:[{id:id(1)}],issues:[{id:id(2)}],observations:[{id:id(3),runId:id(1),issueId:id(2)}]},edges:[edge('agent_runs','observations',['id'],['runId'],'n'),edge('issues','observations',['id'],['issueId'],'n')]})
 const r=await inventoryFactoryEffects(f.db,f.options)
 const effect=r.effects.find(e=>e.table==='observations')
 assert.equal(r.count,3);assert.equal(effect.effect,'set-null');assert.deepEqual(effect.columns,['issueId','runId'])
})

test('explicit SET NULL column subset is respected and delete dominates set-null',async()=>{
 const f=fixture({data:{agents:[{id:id(1),ownerId:'owner'}],links:[{id:id(2),agentId:id(1),ownerId:'owner'}]},edges:[edge('agents','links',['id','ownerId'],['agentId','ownerId'],'n',{null_columns:['agentId']})]})
 assert.deepEqual((await inventoryFactoryEffects(f.db,f.options)).effects.find(e=>e.table==='links').columns,['agentId'])
 f.constraints.push({...f.constraints[0],name:'fk_delete',action:'c',null_columns:null})
 const r=await inventoryFactoryEffects(f.db,f.options)
 assert.equal(r.effects.find(e=>e.table==='links').effect,'delete');assert.deepEqual(r.effects.find(e=>e.table==='links').columns,[])
})

test('foreign schemas, unregistered children, missing composite PK and duplicate registration fail closed',async()=>{
 const make=()=>fixture({data:{agents:[{id:id(1)}],factory_events:[{taskId:id(1),eventId:id(2)}]},pk:{factory_events:['taskId','eventId']},edges:[edge('agents','factory_events',['id'],['taskId'])]})
 for(const mutate of [
  f=>{f.constraints[0].child_schema='public'},f=>{f.constraints[0].parent_schema='public'},
  f=>{f.options.fixtureRows.pop()},f=>{delete f.options.fixtureRows[1].pk.eventId},
  f=>{f.options.fixtureRows.push(f.options.fixtureRows[0])},f=>{f.options.fixtureRows[0].schema='public'},
  f=>{f.options.maxRows=1},f=>{f.constraints[0].action='r'},
 ]){const f=make();mutate(f);await assert.rejects(inventoryFactoryEffects(f.db,f.options))}
})

test('unsafe transaction, unrecognized schemas, wrong roots and invalid budgets are refused',async()=>{
 for(const options of [{readOnly:'off'},{isolation:'read committed'}]){
  const f=fixture(options);await assert.rejects(inventoryFactoryEffects(f.db,f.options));assert.equal(f.queries.length,1)
 }
 for(const mutate of [f=>{f.options.schema='public'},f=>{f.options.schema='factory_192_not_a_uuid'},f=>{f.options.roots=[]},f=>{f.options.maxRows=0},f=>{f.options.maxRows=1001}]){
  const f=fixture();mutate(f);await assert.rejects(inventoryFactoryEffects(f.db,f.options));assert.equal(f.queries.length,0)
 }
})

test('hashes use canonical row order and missing registered root fails closed',async()=>{
 const a=fixture({data:{agents:[{id:id(1),value:'fixture'}]}}),b=fixture({data:{agents:[{value:'fixture',id:id(1)}]}})
 assert.equal((await inventoryFactoryEffects(a.db,a.options)).effects[0].rowHash,(await inventoryFactoryEffects(b.db,b.options)).effects[0].rowHash)
 const f=fixture();f.data.agents=[];await assert.rejects(inventoryFactoryEffects(f.db,f.options))
})

test('SET NULL of a referenced key refuses unmodeled ON UPDATE effects',async()=>{
 const f=fixture({data:{agents:[{id:id(1)}],links:[{id:id(2),agentId:id(1)}],dependent:[{id:id(3),linkAgentId:id(1)}]},edges:[edge('agents','links',['id'],['agentId'],'n'),edge('links','dependent',['agentId'],['linkAgentId'])]})
 await assert.rejects(inventoryFactoryEffects(f.db,f.options),/referenced-key SET NULL/)
})
