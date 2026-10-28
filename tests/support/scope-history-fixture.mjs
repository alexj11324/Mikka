// Source-only historical proof model. Never infer old receipts from the current
// directory inventory or claim that later main migrations ran in a15/2da.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {orderMigrations} from '../../scripts/migration-order.mjs'
import {SCOPE_MIGRATION_IDENTITIES,scopeMigrationBeforeCommit} from '../../scripts/scope-migration-history.mjs'

const hash=value=>createHash('sha256').update(value).digest('hex')
export function retainedScope70Fixture(){
  const inventory=JSON.parse(readFileSync(new URL('../fixtures/scope-history-70.json',import.meta.url),'utf8'))
  if(inventory.sourceCandidate!=='2f693671c33f1db0821667fbd4a4ec3ebf939e07'||inventory.files.length!==70)throw Error('historical scope inventory mismatch')
  const pins=new Map(inventory.files.map(file=>[file.name,file.sha256])),bytes=new Map()
  if(pins.size!==70)throw Error('historical scope source duplicate')
  const migrations=orderMigrations([...pins.keys()]).map(name=>{
    const current=SCOPE_MIGRATION_IDENTITIES.find(file=>file.previous===name||file.earlier===name)?.name??name
    const value=readFileSync(new URL('../../drizzle/'+current,import.meta.url)),sql=value.toString('utf8')
    if(hash(value)!==pins.get(name))throw Error('historical scope SQL changed: '+name)
    const path='drizzle/'+name,before=scopeMigrationBeforeCommit(current,sql)
    bytes.set(path,value)
    return {path,sha256:hash(value),bytes:value.length,target:/^--\s*target:\s*(\w+)/m.exec(sql)?.[1]??'MIKKA_DATABASE_URL',...(before===null?{}:{beforeCommitSha256:hash(before)})}
  })
  return {migrations,readSource:(path,encoding)=>{const value=bytes.get(path);if(!value)throw Error('unknown historical scope source');return encoding?value.toString(encoding):value}}
}
