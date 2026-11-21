import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {buildEve} from './build-eve.mjs'

for (const preset of ['vercel','node-server']) test(`eve ${preset} build selects the upstream queue mode and stamps its actual output`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'mikka-build-eve-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  await mkdir(join(root,'node_modules/eve'),{recursive:true})
  const output=join(root,'apps/eve',preset==='vercel'?'.vercel/output':'.output')
  await mkdir(output,{recursive:true})
  await writeFile(join(root,'node_modules/eve/package.json'),JSON.stringify({version:'1.0.0-rc.9'}))
  const revision='a'.repeat(40),calls=[]
  await buildEve({root,env:{NITRO_PRESET:preset,MIKKA_BUILD_REVISION:revision,...preset==='node-server'?{VERCEL:'1'}:{}},execute(binary,args,options){
    calls.push({binary,args,options})
    assert.deepEqual(args,[join(root,'node_modules/eve/bin/eve.js'),'build'])
    assert.equal(options.env.NITRO_PRESET,preset)
    assert.equal(options.env.EVE_PUBLIC_ROUTE_PREFIX,'/mikka/api/agents')
    assert.equal(options.env.VERCEL,preset==='vercel'?'1':undefined)
  }})
  assert.equal(calls.length,1)
  assert.deepEqual(JSON.parse(await readFile(join(output,'mikka-eve-build.json'),'utf8')),{version:1,eve:'1.0.0-rc.9',revision,preset})
})
