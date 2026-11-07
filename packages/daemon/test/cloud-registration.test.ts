import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Daemon } from '../src/main'

type RegistrationHarness = { register(credential: string): Promise<void>; device: { deviceId: string; workspaceId: string; credential: string }; stopped: boolean; registered: boolean }
function harness(directory: string, registerDevice: () => Promise<{deviceId: string}>, cloud = true) {
  const daemon = Object.assign(Object.create(Daemon.prototype), {
    options: { hostedSubscriptions: cloud, e2bContainerRuntime: cloud, link: { registerDevice } },
    device: { deviceId:'device-a', workspaceId:'workspace-a', credential:'private-test-credential' },
    paths: { dataDir: directory }, log:{ info:vi.fn(), warn:vi.fn() },
    stopped:false, registered:false, harnesses:[], runnerReport:async()=>undefined,
    wakeCommands:vi.fn(),
  }) as RegistrationHarness
  return daemon
}
async function temporary(check:(directory:string)=>Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'registration-main-'))
  const previous = process.env.MIKKA_DEVICE_TYPE
  process.env.MIKKA_DEVICE_TYPE = 'server'
  try { await check(directory) }
  finally {
    if (previous === undefined) delete process.env.MIKKA_DEVICE_TYPE
    else process.env.MIKKA_DEVICE_TYPE = previous
    await rm(directory,{recursive:true,force:true})
  }
}
it('writes only after the actual link registration succeeds with the current installed credential', async () => temporary(async directory => {
  let complete!: (value:{deviceId:string})=>void
  const linked = new Promise<{deviceId:string}>(resolve=>{complete=resolve})
  const daemon = harness(directory,()=>linked)
  const pending = daemon.register(daemon.device.credential)
  await expect(readFile(join(directory,'registration.json'))).rejects.toMatchObject({code:'ENOENT'})
  complete({deviceId:'device-a'}); await pending
  expect(JSON.parse(await readFile(join(directory,'registration.json'),'utf8'))).toEqual({
    version:1,deviceId:'device-a',workspaceId:'workspace-a',
    tokenSha256:createHash('sha256').update(daemon.device.credential).digest('hex')
  })
}))
for (const changed of ['credential','workspaceId'] as const) it('late registration cannot notify after '+changed+' changes', async()=>temporary(async directory=>{
  let complete!:(value:{deviceId:string})=>void
  const linked=new Promise<{deviceId:string}>(resolve=>{complete=resolve})
  const daemon=harness(directory,()=>linked)
  const pending=daemon.register(daemon.device.credential)
  daemon.device[changed]='replaced'; complete({deviceId:'device-a'})
  await expect(pending).rejects.toThrow('Device session changed during registration')
  await expect(readFile(join(directory,'registration.json'))).rejects.toMatchObject({code:'ENOENT'})
}))
it('failed, stopped and ordinary desktop registrations never publish a cloud receipt',async()=>temporary(async directory=>{
  const failed=harness(directory,async()=>{throw new Error('fixture registration refused')})
  await expect(failed.register(failed.device.credential)).rejects.toThrow('fixture registration refused')
  const stopped=harness(directory,async()=>({deviceId:'device-a'}));stopped.stopped=true
  await stopped.register(stopped.device.credential)
  const desktop=harness(directory,async()=>({deviceId:'device-a'}),false)
  await desktop.register(desktop.device.credential)
  await expect(readFile(join(directory,'registration.json'))).rejects.toMatchObject({code:'ENOENT'})
}))
