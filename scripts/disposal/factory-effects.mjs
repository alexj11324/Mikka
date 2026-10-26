import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const ident=v=>{assert.equal(typeof v,'string');assert.match(v,/^[a-zA-Z_][a-zA-Z0-9_]*$/);return `"${v}"`}
const stable=v=>JSON.stringify(v===null||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])))
const key=r=>`${r.table}:${stable(r.pk)}`
const scalar=v=>typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isSafeInteger(v))

// SELECT-only snapshot; caller owns an already open READ ONLY REPEATABLE READ
// transaction. Every affected PK must be registered by setup. No approval/deletion.
// FK effects only: enabled user triggers/rules and NO ACTION/RESTRICT dependencies
// are deliberately not modeled. Original full-migration fixtures remain pending.
export async function inventoryFactoryEffects(db,{schema,roots,fixtureRows,maxRows}) {
 assert.equal(typeof schema,'string')
 const profile=/^(factory_192|monitor_195|questions)_[a-f0-9]{32}$/.exec(schema)?.[1]
 assert.ok(profile,'unknown fixture schema')
 assert.ok(Number.isSafeInteger(maxRows)&&maxRows>0&&maxRows<=1000,'explicit budget required')
 assert.ok(Array.isArray(roots)&&Array.isArray(fixtureRows)&&fixtureRows.length<=10000)
 assert.deepEqual(roots.map(r=>r.table).sort(),{factory_192:['agents'],monitor_195:['agent_runs','issues'],questions:['agent_runs']}[profile],'wrong root contract')
 const isolation=(await db.query("SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation")).rows
 assert.equal(isolation.length,1);assert.equal(isolation[0].read_only,'on');assert.equal(isolation[0].isolation,'repeatable read')
 // Inspect the entire fixture schema, not only already-discovered FK targets:
 // user triggers and rewrite rules can mutate rows outside the FK graph. FK
 // constraint triggers are internal; disabled triggers/rules cannot execute.
 // _RETURN is PostgreSQL's generated view SELECT rule, not a table write rule.
 const sideEffects=await db.query(`SELECT 'trigger' AS side_effect_kind, c.relname AS table_name, t.tgname AS object_name
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=$1 AND NOT t.tgisinternal AND t.tgenabled <> 'D'
 UNION ALL
 SELECT 'rule' AS side_effect_kind, c.relname AS table_name, r.rulename AS object_name
 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=$1 AND r.ev_enabled <> 'D' AND r.rulename <> '_RETURN'`,[schema])
 assert.ok(Array.isArray(sideEffects.rows)&&sideEffects.rows.length===0,'enabled user trigger or rule requires explicit side-effect inventory')
 const metadata=await db.query(`SELECT t.relname AS table_name,
 ARRAY(SELECT a.attname::text FROM unnest(p.conkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.n ORDER BY k.o) AS pk_columns,
 ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull ORDER BY a.attnum) AS not_null_columns
 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_constraint p ON p.conrelid=t.oid AND p.contype='p' WHERE n.nspname=$1 ORDER BY t.relname`,[schema])
 const tables=new Map()
 for(const t of metadata.rows){ident(t.table_name);assert.ok(!tables.has(t.table_name));assert.ok(Array.isArray(t.pk_columns)&&t.pk_columns.length);assert.equal(new Set(t.pk_columns).size,t.pk_columns.length);assert.ok(Array.isArray(t.not_null_columns));for(const c of [...t.pk_columns,...t.not_null_columns])ident(c);tables.set(t.table_name,t)}
 const normalize=r=>{
  assert.ok(r&&(!Object.hasOwn(r,'schema')||r.schema===schema),'cross-schema fixture row');ident(r.table)
  const t=tables.get(r.table);assert.ok(t,'unknown table or missing PK')
  assert.ok(!(Object.hasOwn(r,'pk')&&Object.hasOwn(r,'id')),'ambiguous PK')
  const pk=r.pk??(Object.hasOwn(r,'id')?{id:r.id}:null)
  assert.ok(pk&&typeof pk==='object'&&!Array.isArray(pk),'explicit PK required');assert.deepEqual(Object.keys(pk).sort(),[...t.pk_columns].sort(),'incomplete PK');assert.ok(Object.values(pk).every(scalar),'unknown PK value')
  return {table:r.table,pk:{...pk}}
 }
 const registered=fixtureRows.map(normalize),normalizedRoots=roots.map(normalize),known=new Set(registered.map(key))
 assert.equal(known.size,registered.length,'duplicate registration');assert.equal(new Set(normalizedRoots.map(key)).size,normalizedRoots.length,'duplicate roots')
 for(const r of normalizedRoots)assert.ok(known.has(key(r)),'unregistered root')
 const {rows:edges}=await db.query(`SELECT sn.nspname AS child_schema,dn.nspname AS parent_schema,src.relname AS child,dst.relname AS parent,c.conname AS name,c.confdeltype AS action,
 ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.o) AS child_columns,
 ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.o) AS parent_columns,
 CASE WHEN c.confdelsetcols IS NULL THEN NULL ELSE ARRAY(SELECT a.attname::text FROM unnest(c.confdelsetcols) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.o) END AS null_columns
 FROM pg_constraint c JOIN pg_class src ON src.oid=c.conrelid JOIN pg_class dst ON dst.oid=c.confrelid JOIN pg_namespace sn ON sn.oid=src.relnamespace JOIN pg_namespace dn ON dn.oid=dst.relnamespace
 WHERE c.contype='f' AND (sn.nspname=$1 OR dn.nspname=$1) ORDER BY src.relname,c.conname`,[schema])
 for(const e of edges){
  assert.equal(e.child_schema,schema,'external FK');assert.equal(e.parent_schema,schema,'external FK');ident(e.child);ident(e.parent);ident(e.name)
  assert.ok(tables.has(e.child)&&tables.has(e.parent),'unknown FK table or missing PK');assert.ok(Array.isArray(e.child_columns)&&Array.isArray(e.parent_columns));assert.ok(e.child_columns.length&&e.child_columns.length===e.parent_columns.length);assert.equal(new Set(e.child_columns).size,e.child_columns.length)
  assert.ok(['c','n','a','r','d'].includes(e.action),'unknown FK action');for(const c of [...e.child_columns,...e.parent_columns])ident(c)
  if(e.null_columns!=null){assert.ok(Array.isArray(e.null_columns)&&e.null_columns.length);assert.equal(new Set(e.null_columns).size,e.null_columns.length);for(const c of e.null_columns)assert.ok(e.child_columns.includes(c),'unknown SET NULL column')}
 }
 const pending=normalizedRoots.map(r=>({...r,effect:'delete',columns:[]})),effects=new Map()
 while(pending.length){
  const item=pending.shift(),k=key(item);assert.ok(known.has(k),'unregistered effect');const previous=effects.get(k)
  if(previous?.effect==='delete')continue
  // A nullable referenced key could trigger ON UPDATE effects. Do not silently
  // inventory it as a leaf; this helper covers delete cascades and leaf nulling.
  if(item.effect==='set-null')assert.ok(!edges.some(e=>e.parent===item.table&&e.parent_columns.some(c=>item.columns.includes(c))),'referenced-key SET NULL requires explicit review')
  if(previous&&item.effect==='set-null'){previous.columns=[...new Set([...previous.columns,...item.columns])].sort();continue}
  const pk=tables.get(item.table).pk_columns,where=pk.map((c,i)=>`${ident(c)}=$${i+1}`).join(' AND ')
  const {rows}=await db.query(`SELECT to_jsonb(t) AS row FROM ${ident(schema)}.${ident(item.table)} t WHERE ${where} LIMIT 2`,pk.map(c=>item.pk[c]))
  assert.equal(rows.length,1,'fixture missing or ambiguous');const current=rows[0].row;assert.ok(current&&typeof current==='object'&&!Array.isArray(current))
  assert.equal(key(normalize({table:item.table,pk:Object.fromEntries(pk.map(c=>[c,current[c]]))})),k,'fixture PK mismatch')
  effects.set(k,{...item,columns:[...item.columns].sort(),rowHash:createHash('sha256').update(stable(current)).digest('hex')});assert.ok(effects.size<=maxRows,'effect budget exceeded')
  if(item.effect!=='delete')continue
  for(const e of edges.filter(e=>e.parent===item.table)){
   const values=e.parent_columns.map(c=>{assert.ok(Object.hasOwn(current,c),'unknown referenced column');return current[c]});if(values.some(v=>v===null))continue
   const filter=e.child_columns.map((c,i)=>`${ident(c)}=$${i+1}`).join(' AND ')
   const children=await db.query(`SELECT to_jsonb(t) AS row FROM ${ident(schema)}.${ident(e.child)} t WHERE ${filter} LIMIT $${values.length+1}`,[...values,maxRows+1]);if(!children.rows.length)continue
   assert.ok(['c','n'].includes(e.action),'restrict/default FK requires explicit review')
   const columns=e.action==='n'?(e.null_columns??e.child_columns):[]
   assert.ok(columns.every(c=>!tables.get(e.child).not_null_columns.includes(c)),'SET NULL conflicts with NOT NULL')
   for(const {row} of children.rows){assert.ok(row&&typeof row==='object'&&!Array.isArray(row));for(let i=0;i<values.length;i++)assert.deepEqual(row[e.child_columns[i]],values[i],'FK target mismatch')
    const child=normalize({table:e.child,pk:Object.fromEntries(tables.get(e.child).pk_columns.map(c=>[c,row[c]]))});assert.ok(known.has(key(child)),'external or unregistered cascade target');pending.push({...child,effect:e.action==='c'?'delete':'set-null',columns})
   }
  }
 }
 return {schema,roots:normalizedRoots,count:effects.size,effects:[...effects.values()].sort((a,b)=>key(a).localeCompare(key(b))),constraints:edges,executedDeletion:false}
}
