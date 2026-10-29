import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { startPublicEgress } from '../src/agents/public-egress'
import { HOSTED_NATIVE_IMAGE } from '@mikka/protocol/subscription'
const exec = promisify(execFile)

// Explicit infrastructure acceptance: a real network-none Docker container and
// the production relay/proxy fetch public package metadata. No model, account,
// or third-party write is involved. Keep the stopped container and evidence.
test('network-none Docker downloads public package metadata through its owned proxy', { skip: process.env.MIKKA_PUBLIC_EGRESS_DOCKER !== '1', timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(),'mikka-egress-acceptance-'))
  const name = `mikka-egress-${randomUUID()}`
  const lifetime = new AbortController()
  const destinations: {host:string;port:number}[]=[]
  const proxy = await startPublicEgress({signal:lifetime.signal,authorize:async target=>{destinations.push(target);return true}})
  const script = `import {startNativeEgress} from '/native-egress.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const relay=await startNativeEgress();
try{const r=await promisify(execFile)('npm',['view','is-number@7.0.0','version','--proxy',relay.url,'--https-proxy',relay.url,'--cache','/tmp/npm-cache'],{env:{PATH:process.env.PATH,HOME:'/tmp',HTTP_PROXY:relay.url,HTTPS_PROXY:relay.url},timeout:60000});if(r.stdout.trim()!=='7.0.0')throw Error('unexpected metadata');console.log('public-download: 7.0.0');}finally{await relay.close();}`
  await writeFile(join(directory,'probe.mjs'),script)
  try {
    await exec('docker',['create','--pull=never','--name',name,'--label','mikka.test=public-egress','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',`${process.getuid!()}:${process.getgid!()}`,'--tmpfs','/tmp:rw,nosuid,nodev,size=128m','-v',`${proxy.socketPath}:/run/mikka-egress.sock:ro`,'-v',`${resolve('packages/daemon/src/agents/native-egress.mjs')}:/native-egress.mjs:ro`,'-v',`${join(directory,'probe.mjs')}:/probe.mjs:ro`,HOSTED_NATIVE_IMAGE,'node','/probe.mjs'])
    const result=await exec('docker',['start','-a',name],{timeout:90_000})
    await writeFile(join(directory,'stdout.log'),result.stdout)
    await writeFile(join(directory,'stderr.log'),result.stderr)
    const inspect=await exec('docker',['inspect',name])
    await writeFile(join(directory,'container.json'),inspect.stdout)
    const info=JSON.parse(inspect.stdout)[0]
    assert.equal(info.State.ExitCode,0)
    assert.equal(info.HostConfig.NetworkMode,'none')
    assert.equal(info.HostConfig.ReadonlyRootfs,true)
    assert.match(result.stdout,/public-download: 7\.0\.0/)
    assert.ok(destinations.some(value=>value.host==='registry.npmjs.org' && value.port===443))
    console.log(JSON.stringify({container:name,evidence:directory,network:info.HostConfig.NetworkMode,publicDownload:true}))
  } finally {lifetime.abort();await proxy.close()}
})
