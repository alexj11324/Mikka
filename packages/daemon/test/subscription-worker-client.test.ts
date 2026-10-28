import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SubscriptionWorkerClient } from '../src/subscription-worker-client'
import { cleanupTempDirs, tempDir } from './helpers'

afterEach(cleanupTempDirs)
function fixture(hold = false, resolveIdentity?: (executionOnly: boolean, signal?: AbortSignal) => Promise<{ workloadToken?: string; accessToken?: string; accessSnapshot?: {name: string; value: string} }>, accessProject?: string, snapshotMode = false) {
  const directory = tempDir('mikka-worker-boundary-')
  const journal = join(directory, 'calls')
  const binary = join(directory, 'worker.mjs')
  writeFileSync(journal, '')
  writeFileSync(binary, `#!/usr/bin/env node
import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';
let config;const lines=createInterface({input:process.stdin});lines.on('line',line=>{const value=JSON.parse(line);if(!config){config=value;return};const request=value;appendFileSync(${JSON.stringify(journal)},request.method+'\\n');
const result={fullAuthority:Boolean(config.workloadToken||config.path),sourceAuthority:Boolean(config.enrollmentAttemptPath||config.enrollmentClaimPath||config.enrollmentGrantPath),accessAuthority:config.accessToken==='fixture-access-reader',snapshot:config.accessSnapshot?.name,binding:config.use?.bindingId,consumer:config.use?.consumerId,accessProject:config.accessProject};
if(request.method==='prepare'){setTimeout(()=>{console.log(JSON.stringify({id:request.id,result:{ready:true}}));lines.close()},${hold ? 500 : 0});return}
if(request.method==='nativeStream'){console.log(JSON.stringify({id:request.id,head:{contentType:'application/json'}}));for(const byte of Buffer.from(JSON.stringify({...result,text:'汉字🙂'})))console.log(JSON.stringify({id:request.id,binaryChunk:Buffer.from([byte]).toString('base64')}));console.log(JSON.stringify({id:request.id,result:{done:true}}));lines.close();return}
if(request.method==='executeStream'){console.log(JSON.stringify({id:request.id,chunk:JSON.stringify(result)}));console.log(JSON.stringify({id:request.id,result:{done:true}}))}else console.log(JSON.stringify({id:request.id,result}));lines.close()})
`)
  chmodSync(binary, 0o700)
  const client = new SubscriptionWorkerClient({ binary }, {
    scope: { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', connectionId: '20000000-0000-4000-8000-000000000001', provider: 'codex' },
    databaseUrl: 'synthetic', infisicalOrigin: 'https://fixture.invalid', project: 'fixture', environment: 'test', path: '/grants', workloadToken: 'fixture-custody-identity', accessPath: '/access', accessProject, accessToken: snapshotMode ? undefined : 'fixture-access-reader', enableRuntime: true, enrollmentAttemptPath: '/attempts', enrollmentClaimPath: '/claims', enrollmentGrantPath: '/pending'
  }, resolveIdentity).forUse({ bindingId: '20000000-0000-4000-8000-000000000002', consumerId: 'fixture-task' })
  return { client, journal }
}
it('quota and inference children receive no full-bundle identity and retain the exact task binding', async () => {
  const { client } = fixture()
  expect(await client.call('quota', { revision: 2 })).toEqual({ fullAuthority: false, sourceAuthority: false, accessAuthority: true, binding: '20000000-0000-4000-8000-000000000002', consumer: 'fixture-task' })
  let text = ''
  for await (const chunk of client.stream(2, 'fixture-model', {})) text += new TextDecoder().decode(chunk)
  expect(JSON.parse(text)).toMatchObject({ fullAuthority: false, sourceAuthority: false, accessAuthority: true, consumer: 'fixture-task' })
})
it('cancelling during preparation cannot start inference afterward', async () => {
  const { client, journal } = fixture(true)
  const reader = client.stream(2, 'fixture-model', {}).getReader()
  await new Promise(resolve => setTimeout(resolve, 100))
  await reader.cancel()
  await new Promise(resolve => setTimeout(resolve, 650))
  expect(readFileSync(journal, 'utf8')).not.toContain('executeStream')
})
it('native broker requests retain the task and access-reader boundary and preserve split UTF-8 bytes', async () => {
  const { client } = fixture()
  const response = await client.nativeRequest(2, {path:'/responses',headers:{},body:{model:'fixture-model'}})
  expect(response.contentType).toBe('application/json')
  expect(await new Response(response.body).json()).toMatchObject({fullAuthority:false,sourceAuthority:false,accessAuthority:true,consumer:'fixture-task',text:'汉字🙂'})
  expect(await client.call('nativeContext', {revision:2})).toMatchObject({fullAuthority:false,sourceAuthority:false,accessAuthority:true})
})

it('custody retains source cleanup paths without exposing them to execution children', async () => {
  const { client } = fixture()
  expect(await client.call('status')).toMatchObject({ fullAuthority: true, sourceAuthority: true })
})

it('resolves only the identity required for each worker and strips custody from execution', async () => {
  const calls: boolean[] = []
  const { client } = fixture(false, async executionOnly => {
    calls.push(executionOnly)
    return executionOnly ? { workloadToken: 'must-not-cross-boundary', accessToken: 'fixture-access-reader' } : { workloadToken: 'fixture-custody-identity' }
  })
  expect(await client.call('status')).toMatchObject({ fullAuthority: true, sourceAuthority: true })
  expect(await client.call('quota')).toMatchObject({ fullAuthority: false, sourceAuthority: false, accessAuthority: true })
  expect(calls).toEqual([false, true])
})

it('passes the dedicated access project to custody and restricted execution workers', async () => {
  const { client } = fixture(false, undefined, 'isolated-access-project')
  expect(await client.call('status')).toMatchObject({ fullAuthority: true, accessProject: 'isolated-access-project' })
  expect(await client.call('quota')).toMatchObject({ fullAuthority: false, accessProject: 'isolated-access-project' })
})

it('passes only the selected access snapshot to an execution child when an identity is shared', async () => {
  const name = 'mikka-byos-00000000-0000-4000-8000-000000000001'
  const { client } = fixture(false, async executionOnly => executionOnly ? { accessSnapshot: { name, value: 'projection' } } : { workloadToken: 'fixture-custody-identity' }, undefined, true)
  expect(await client.call('quota', { revision: 2 })).toMatchObject({ fullAuthority: false, sourceAuthority: false, accessAuthority: false, snapshot: name })
})

it('does not start a worker request if identity resolution fails or is cancelled', async () => {
  const { client, journal } = fixture(false, async () => { throw new Error('secret must not leak') })
  await expect(client.call('status')).rejects.toThrow('subscription_worker_unavailable')
  expect(readFileSync(journal, 'utf8')).toBe('')
  const aborted = new AbortController()
  aborted.abort()
  await expect(client.call('status', {}, aborted.signal)).rejects.toThrow('subscription_cancelled')
})
