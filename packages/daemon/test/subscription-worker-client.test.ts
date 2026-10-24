import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SubscriptionWorkerClient } from '../src/subscription-worker-client'
import { cleanupTempDirs, tempDir } from './helpers'

afterEach(cleanupTempDirs)
function fixture(hold = false) {
  const directory = tempDir('mikka-worker-boundary-')
  const journal = join(directory, 'calls')
  const binary = join(directory, 'worker.mjs')
  writeFileSync(journal, '')
  writeFileSync(binary, `#!/usr/bin/env node
import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';
let config;const lines=createInterface({input:process.stdin});lines.on('line',line=>{const value=JSON.parse(line);if(!config){config=value;return};const request=value;appendFileSync(${JSON.stringify(journal)},request.method+'\\n');
const result={fullAuthority:Boolean(config.workloadToken||config.path),accessAuthority:config.accessToken==='fixture-access-reader',binding:config.use?.bindingId,consumer:config.use?.consumerId};
if(request.method==='prepare'){setTimeout(()=>{console.log(JSON.stringify({id:request.id,result:{ready:true}}));lines.close()},${hold ? 500 : 0});return}
if(request.method==='executeStream'){console.log(JSON.stringify({id:request.id,chunk:JSON.stringify(result)}));console.log(JSON.stringify({id:request.id,result:{done:true}}))}else console.log(JSON.stringify({id:request.id,result}));lines.close()})
`)
  chmodSync(binary, 0o700)
  const client = new SubscriptionWorkerClient({ binary }, {
    scope: { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', connectionId: '20000000-0000-4000-8000-000000000001', provider: 'codex' },
    databaseUrl: 'synthetic', infisicalOrigin: 'https://fixture.invalid', project: 'fixture', environment: 'test', path: '/grants', workloadToken: 'fixture-custody-identity', accessPath: '/access', accessToken: 'fixture-access-reader', enableRuntime: true
  }).forUse({ bindingId: '20000000-0000-4000-8000-000000000002', consumerId: 'fixture-task' })
  return { client, journal }
}
it('quota and inference children receive no full-bundle identity and retain the exact task binding', async () => {
  const { client } = fixture()
  expect(await client.call('quota', { revision: 2 })).toEqual({ fullAuthority: false, accessAuthority: true, binding: '20000000-0000-4000-8000-000000000002', consumer: 'fixture-task' })
  let text = ''
  for await (const chunk of client.stream(2, 'fixture-model', {})) text += new TextDecoder().decode(chunk)
  expect(JSON.parse(text)).toMatchObject({ fullAuthority: false, accessAuthority: true, consumer: 'fixture-task' })
})
it('cancelling during preparation cannot start inference afterward', async () => {
  const { client, journal } = fixture(true)
  const reader = client.stream(2, 'fixture-model', {}).getReader()
  await new Promise(resolve => setTimeout(resolve, 100))
  await reader.cancel()
  await new Promise(resolve => setTimeout(resolve, 650))
  expect(readFileSync(journal, 'utf8')).not.toContain('executeStream')
})
