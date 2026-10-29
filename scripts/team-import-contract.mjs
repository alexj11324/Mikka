// Real locked dependency linking and initialization, stopped before native SQL.
import './credential-diagnostics-offline.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import net from 'node:net'
import ts from 'typescript'
import pg from 'pg'
import { scopeNativeRuntime } from './scope-acceptance-runtime.mjs'
import { SCOPE_DATABASES, scopeUrl } from './scope-acceptance-policy.mjs'

export function teamImportInventory(source) {
  const file=ts.createSourceFile('team-test.ts',source,ts.ScriptTarget.Latest,true)
  const imports=[]
  function visit(node) {
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword) {
      if(!ts.isStringLiteral(node.arguments[0]))throw Error('team import inventory requires literal module targets')
      let parent=node.parent
      if(ts.isAwaitExpression(parent))parent=parent.parent
      const exports=ts.isVariableDeclaration(parent)&&ts.isObjectBindingPattern(parent.name)
        ?parent.name.elements.map(element=>(element.propertyName??element.name).text):[]
      imports.push({specifier:node.arguments[0].text,exports})
    }
    ts.forEachChild(node,visit)
  }
  visit(file)
  return imports
}

export async function verifyTeamImportsOffline() {
  let nativeTransportAttempts=0,nativeSqlSubmissions=0,deniedConnections=0
  const unexpected=[]
  const onRejection=error=>{if(!String(error?.message).includes('OFFLINE_TEAM_SQL_BOUNDARY'))unexpected.push(error)}
  process.on('unhandledRejection',onRejection)
  net.Socket.prototype.connect=()=>{nativeTransportAttempts++;throw Error('offline transport forbidden')}
  pg.Client.prototype.query=()=>{nativeSqlSubmissions++;throw Error('offline SQL forbidden')}
  Object.assign(process.env,{MIKKA_DATABASE_URL:scopeUrl(SCOPE_DATABASES.app),DATABASE_URL:scopeUrl(SCOPE_DATABASES.workspace)})
  const paths=execFileSync('git',['ls-files','-z','--','*.ts','*.tsx','*.mjs','*.js','*.json'],{encoding:'utf8',timeout:5000}).split('\0').filter(Boolean)
  const frozen=new Map(paths.map(path=>[resolve(path),readFileSync(path)]))
  const runtime=scopeNativeRuntime(pg,async(kind,input)=>{
    if(kind==='connect'){
      assert.ok([scopeUrl(SCOPE_DATABASES.app),scopeUrl(SCOPE_DATABASES.workspace)].includes(input.url))
      deniedConnections++;throw Error('OFFLINE_TEAM_SQL_BOUNDARY')
    }
    if(['query','migrate','cleanup'].includes(kind))throw Error('offline import reached unexpected SQL/migration capability')
  },'team','suite')
  runtime.install(frozen)
  const {installTeamSessionFixture}=await import('../tests/fixtures/team-auth-runtime.mjs')
  const authModule=await import('../lib/auth.ts')
  const context=authModule.auth.$context.then(()=>({initialized:true}),error=>({error}))
  const before=Object.getOwnPropertyDescriptors(authModule)
  const api=authModule.auth.api,session=Object.getOwnPropertyDescriptor(api,'getSession')
  const otherEndpoints=Object.entries(Object.getOwnPropertyDescriptors(api)).filter(([name])=>name!=='getSession')
  const sameDescriptor=(actual,expected,label)=>{for(const key of ['value','get','set','writable','enumerable','configurable'])assert.ok(Object.is(actual?.[key],expected?.[key]),`${label} descriptor ${key} changed`)}
  const restore=installTeamSessionFixture(authModule.auth)
  try {
    assert.equal(authModule.auth.api,api)
    assert.equal(api.getSession.path,session.value.path);assert.equal(api.getSession.options,session.value.options)
    assert.equal(await api.getSession({headers:new Headers()}),null)
    globalThis.teamCreateTestUser='team-offline-contract'
    assert.equal((await api.getSession({headers:new Headers()})).user.id,'team-offline-contract')
    globalThis.teamCreateTestUser=undefined
    for(const [name,descriptor]of otherEndpoints)sameDescriptor(Object.getOwnPropertyDescriptor(api,name),descriptor,name)
    for(const key of Reflect.ownKeys(before))sameDescriptor(Object.getOwnPropertyDescriptor(authModule,key),before[key],String(key))
    for(const name of ['githubEnabled','googleEnabled','authBaseURL','oauthCallbackBaseURL','auth'])assert.ok(Object.hasOwn(authModule,name))
    const source=readFileSync('tests/team-issue-create.db.test.ts','utf8'),inventory=teamImportInventory(source)
    const entry=pathToFileURL(resolve('tests/team-issue-create.db.test.ts'))
    for(const item of inventory) {
      const target=item.specifier.startsWith('.')?new URL(item.specifier,entry).href:item.specifier
      const module=await import(target)
      for(const name of item.exports)assert.ok(Object.hasOwn(module,name),`${item.specifier} missing ${name}`)
    }
    const outcome=await Promise.race([context,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('offline auth initialization did not reach its boundary')),5000);timer.unref()})])
    if(outcome.error)assert.match(outcome.error.message,/OFFLINE_TEAM_SQL_BOUNDARY/)
    await new Promise(resolve=>setImmediate(resolve))
    assert.deepEqual(unexpected,[]);assert.ok(deniedConnections>0)
    assert.equal(nativeTransportAttempts,0);assert.equal(nativeSqlSubmissions,0)
    console.log(JSON.stringify({teamImportContract:true,dynamicImportOccurrences:inventory.length,uniqueModules:new Set(inventory.map(item=>item.specifier)).size,scenarios:source.split('scopeSubtest(t,').length-1,realAuthExports:Object.keys(authModule),deniedConnections,nativeTransportAttempts,nativeSqlSubmissions}))
  } finally {
    restore();sameDescriptor(Object.getOwnPropertyDescriptor(api,'getSession'),session,'restoredgetSession')
    await runtime.close();process.removeListener('unhandledRejection',onRejection)
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)verifyTeamImportsOffline().catch(error=>{console.error(error);process.exitCode=1})
