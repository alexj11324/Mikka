import assert from 'node:assert/strict'
import test from 'node:test'
import {fingerprint} from '../credentials/fingerprint'
import {maskEveStream} from './stream-mask'

async function project(lines:unknown[],after=0,secret?:string) {
  const encode=new TextEncoder()
  const input=new ReadableStream<Uint8Array>({start(controller){for(const line of lines)controller.enqueue(encode.encode(JSON.stringify(line)+'\n'));controller.close()}})
  const response=new Response(input.pipeThrough(maskEveStream('owner',secret?[fingerprint('owner',secret)]:[],after)))
  return (await response.text()).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
}
const delta=(text:string)=>({progress:{type:'content.delta',data:{partId:'part',kind:'text',delta:text}}})
const complete=(text:string)=>({at:'2026-11-11T00:00:00Z',facts:[{type:'content.completed',scope:{turnId:'turn'},data:{partId:'part',kind:'text',value:text,phase:'reply'}}]})

test('native first-token progress and source-line cursor survive security projection',async()=>{
  const lines=[delta('Hello'),delta(' world'),complete('Hello world')]
  const whole=await project(lines)
  assert.equal(whole.length,3)
  assert.equal(whole[0].progress.data.delta,'Hello')
  assert.deepEqual(await project(lines,1),whole.slice(1))
})
test('saved secret split across content chunks cannot leave, including after reconnect',async()=>{
  const prior=process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET='fixture-host-key-with-more-than-thirty-two-characters'
  try {
    const secret='sensitive-fixture-value'
    const lines=[delta('Safe text '+secret.slice(0,8)),delta(secret.slice(8)),complete('Safe text '+secret)]
    const whole=await project(lines,0,secret)
    assert.equal(whole.length,3)
    assert.equal(JSON.stringify(whole).includes(secret),false)
    assert.equal(JSON.stringify(whole).includes(secret.slice(0,8)),false)
    assert.equal(whole.at(-1).facts[0].data.value,'[redacted]')
    assert.deepEqual(await project(lines,1,secret),whole.slice(1))
  }finally{if(prior===undefined)delete process.env.BETTER_AUTH_SECRET;else process.env.BETTER_AUTH_SECRET=prior}
})
test('a long part preserves native progress and the fingerprint window on reconnect', async t => {
  t.mock.property(process, 'env', {...process.env, BETTER_AUTH_SECRET:'local-only-fingerprint-fixture-key-for-native-progress'})
  const secret = 'ordinary saved fixture'
  const text = 'one ordinary sentence. '.repeat(4)
  const prefix = Array.from({length:64}, () => delta(text))
  const whole = await project([...prefix, complete(text.repeat(64))], 0, secret)
  const released = whole.slice(0,-1).map(line => line.progress.data.delta).join('')
  assert.equal(released, text.repeat(64).slice(0,-(secret.length-1)))
  const lines = [...prefix, ...Array.from(secret, character => delta(character)), complete(text.repeat(64)+secret)]
  const projected = await project(lines, 0, secret)
  assert.equal(projected.slice(0,-1).map(line => line.progress.data.delta).join(''), text.repeat(64))
  assert.equal(projected.at(-1).facts[0].data.value, '[redacted]')
  assert.deepEqual(await project(lines, prefix.length, secret), projected.slice(prefix.length))
})
test('native partial tool arguments stay private and committed previews are masked',async()=>{
  const lines=[{progress:{type:'call.input',data:{callId:'call',name:'tool',delta:'secret-in-progress'}}},{at:'2026-11-11T00:00:00Z',facts:[{type:'call.requested',data:{callId:'call',input:{authorization:'Bearer sk-fixture_abcdefghijklmnopqrstuvwxyz123456789'},owner:{turnId:'turn'},capability:{kind:'tool',name:'tool'}}}]}]
  const out=await project(lines)
  assert.equal(out[0].progress.data.delta,'')
  assert.equal(JSON.stringify(out).includes('secret-in-progress'),false)
  assert.equal(JSON.stringify(out).includes('sk-fixture_abcdefghijklmnopqrstuvwxyz123456789'),false)
})
