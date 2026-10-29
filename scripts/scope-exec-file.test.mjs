import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile as nativeExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scopeExecFile,scopeWireOutput,scopeOutputFromWire,scopeRpcError } from './scope-exec-file.mjs'

function nativeBridge(onChild=()=>{}) {
  return scopeExecFile((file,args,options)=>{
    let child
    const promise=new Promise((resolve,reject)=>{
      const nativeOptions={...options,encoding:'buffer'}
      delete nativeOptions.signal;delete nativeOptions.timeout
      child=nativeExecFile(file,args,nativeOptions,(error,stdout,stderr)=>{
        const wire=JSON.parse(JSON.stringify(scopeWireOutput({stdout,stderr})))
        if(error)reject(scopeRpcError({...wire,message:error.message,code:error.code,signal:error.signal,killed:error.killed}))
        else resolve(scopeOutputFromWire(wire))
      })
      onChild(child)
    })
    return {promise,cancel:signal=>child.kill(signal)}
  })
}
const args=code=>['--input-type=module','-e',code]

test('real execFile custom promisify returns stdout/stderr and the supervised bridge preserves migration success parsing',async()=>{
  const code="process.stdout.write('migrate: applied 20261027183117_personal_scope_detachment.sql\\n');process.stderr.write('synthetic diagnostic')"
  const native=await promisify(nativeExecFile)(process.execPath,args(code))
  const operation=promisify(nativeBridge())(process.execPath,args(code))
  assert.equal(typeof operation.child.kill,'function')
  const bridged=await operation
  assert.deepEqual(bridged,native)
  assert.match(bridged.stdout,/applied 20261027183117_personal_scope_detachment.sql/)
  assert.equal(bridged.stderr,'synthetic diagnostic')
})
test('real binary output survives IPC wire format and buffer/null/utf8 encodings',async()=>{
  const code="process.stdout.write(Buffer.from([0,255,65,226,156,147]));process.stderr.write(Buffer.from([0,128,66]))"
  for(const encoding of ['buffer',null,'utf8','base64']){
    const native=await promisify(nativeExecFile)(process.execPath,args(code),{encoding})
    const bridged=await promisify(nativeBridge())(process.execPath,args(code),{encoding})
    assert.deepEqual(bridged,native)
  }
})
test('callback form preserves both output values and nonzero error carries partial stdout/stderr',async()=>{
  const bridge=nativeBridge()
  await new Promise((resolve,reject)=>bridge(process.execPath,args("process.stdout.write('out');process.stderr.write('err')"),(error,stdout,stderr)=>{
    try{assert.equal(error,null);assert.equal(stdout,'out');assert.equal(stderr,'err');resolve()}catch(e){reject(e)}
  }))
  const code="process.stdout.write('partial out');process.stderr.write('partial err');process.exit(7)"
  const native=await promisify(nativeExecFile)(process.execPath,args(code)).catch(error=>error)
  const bridged=await promisify(bridge)(process.execPath,args(code)).catch(error=>error)
  for(const key of ['code','signal','killed','stdout','stderr'])assert.deepEqual(bridged[key],native[key])
})
test('abort cancels the real owned child and rejects with partial output; pre-abort does not launch',async()=>{
  const controller=new AbortController()
  const bridge=nativeBridge(child=>child.stdout.once('data',()=>controller.abort()))
  const operation=promisify(bridge)(process.execPath,args("process.stdout.write('ready');setInterval(()=>{},1000)"),{signal:controller.signal})
  await assert.rejects(operation,error=>error.code==='ABORT_ERR'&&error.name==='AbortError'&&error.stdout==='ready'&&error.killed===true)
  let launches=0
  const blocked=scopeExecFile(()=>{launches++;throw Error('must not launch')})
  await assert.rejects(promisify(blocked)(process.execPath,[],{signal:AbortSignal.abort()}),{code:'ABORT_ERR'})
  assert.equal(launches,0)
})
test('timeout and explicit kill settle once and retain output/error contract',async()=>{
  const operation=promisify(nativeBridge())(process.execPath,args("process.stdout.write('before timeout');setInterval(()=>{},1000)"),{timeout:100})
  await assert.rejects(operation,error=>error.code==='ETIMEDOUT'&&error.killed===true&&typeof error.stdout==='string')
  const bridge=nativeBridge(child=>child.stdout.once('data',()=>operation2.child.kill()))
  const operation2=promisify(bridge)(process.execPath,args("process.stdout.write('before kill');setInterval(()=>{},1000)"))
  await assert.rejects(operation2,error=>error.killed===true&&error.signal==='SIGTERM'&&error.stdout==='before kill')
})
test('buffer limits and unsupported encoding fail clearly without changing successful result shape',async()=>{
  const launch=()=>({promise:Promise.resolve({stdout:Buffer.from('abcdef'),stderr:Buffer.alloc(0)}),cancel(){}})
  await assert.rejects(promisify(scopeExecFile(launch))('synthetic',[],{maxBuffer:3}),error=>error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'&&error.stdout==='abc')
  assert.throws(()=>scopeExecFile(launch)('synthetic',[],{encoding:'not-an-encoding'}),/encoding/)
})
