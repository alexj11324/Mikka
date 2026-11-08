import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { writeCloudRegistration } from '../../packages/daemon/src/cloud-registration'
import { REGISTRATION_SCRIPT, REGISTRATION_COMPLETE, REGISTRATION_LEGACY, quoteShell, type RegistrationCommand } from './registration-command'

const credential = 'orv_' + 'x'.repeat(43)
const deviceId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const workspaceId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const tokenSha256 = createHash('sha256').update(credential).digest('hex')
const writer = resolve('packages/daemon/src/cloud-registration.ts')
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mikka-register-'))
  chmodSync(directory, 0o700)
  const workerSha = 'd'.repeat(40)
  const runtimeRoot = join(directory, 'runtime')
  const release = join(runtimeRoot, 'releases', '1'.repeat(40))
  const source = join(release, 'source')
  const capability = join(source, 'packages/daemon/dist/cloud/runtime-capabilities.json')
  mkdirSync(join(source, 'packages/daemon/dist/cloud'), { recursive:true })
  symlinkSync(source, join(runtimeRoot, 'worker'))
  writeFileSync(join(runtimeRoot, 'worker-source-sha'), workerSha, { mode:0o444 })
  writeFileSync(join(release, 'worker-ready.sha'), workerSha, { mode:0o444 })
  writeFileSync(capability, JSON.stringify({ registrationNoticeVersion:1,workerSha }), { mode:0o444 })
  const body = { version:1,deviceId,workspaceId,tokenSha256 }
  const file = join(directory, 'registration.json')
  const config: RegistrationCommand = { directory,deviceId,workspaceId,tokenSha256,
    publish:':',wake:'printf awake',wakeReceipt:'awake',start:'exit 92',timeoutMs:180,workerSha,runtimeRoot }
  const notify = (tail = '') => 'exec '+quoteShell(process.execPath)+' --import tsx --input-type=module -e '+quoteShell(
    'import {writeCloudRegistration} from '+JSON.stringify(writer)+';'+
    'writeCloudRegistration('+[directory,deviceId,workspaceId,credential].map(x=>JSON.stringify(x)).join(',')+');'+tail)
  return { directory,file,body,config,notify,capability,source,runtimeRoot,close:()=>rmSync(directory,{recursive:true,force:true}) }
}
async function run(config: RegistrationCommand) {
  const child = spawn(process.execPath, ['--input-type=module','-e',REGISTRATION_SCRIPT,JSON.stringify(config)], { stdio:['ignore','pipe','pipe'] })
  let stdout='',stderr=''
  child.stdout.setEncoding('utf8').on('data',x=>{stdout+=x})
  child.stderr.setEncoding('utf8').on('data',x=>{stderr+=x})
  const timeout = setTimeout(()=>child.kill('SIGKILL'), 5000)
  try { const [code] = await once(child,'close'); return { code,stdout,stderr } }
  finally { clearTimeout(timeout) }
}
test('atomic notification contains only the installed identity and credential hash', () => {
  const f=fixture()
  try {
    writeCloudRegistration(f.directory,deviceId,workspaceId,credential)
    const raw=readFileSync(f.file,'utf8')
    assert.deepEqual(JSON.parse(raw),f.body)
    assert.equal(raw.includes(credential),false)
    assert.equal(statSync(f.file).mode&0o777,0o600)
  } finally { f.close() }
})
test('watch installed before publish catches a real receipt written during that publication', async () => {
  const f=fixture()
  try {
    const result=await run({...f.config,publish:f.notify()})
    assert.equal(result.code,0,result.stderr)
    assert.ok(result.stdout.includes(REGISTRATION_COMPLETE))
  } finally { f.close() }
})
test('read after watch also accepts an already complete matching receipt', async () => {
  const f=fixture()
  try { writeCloudRegistration(f.directory,deviceId,workspaceId,credential);assert.equal((await run(f.config)).code,0) }
  finally { f.close() }
})
for(const [label,patch] of Object.entries({oldToken:{tokenSha256:'c'.repeat(64)},otherDevice:{deviceId:workspaceId},otherWorkspace:{workspaceId:deviceId},unknownField:{secret:'not-a-credential'}})) {
  test('refuses '+label+' despite a successful wake signal', async () => {
    const f=fixture()
    try {
      writeFileSync(f.file,JSON.stringify({...f.body,...patch}),{mode:0o600})
      const r=await run(f.config)
      assert.equal(r.code,1);assert.equal(r.stderr,'cloud_registration_timeout\n')
    } finally { f.close() }
  })
}
test('a signal acknowledgement without registration is not readiness', async () => {
  const f=fixture()
  try { const r=await run(f.config);assert.equal(r.code,1);assert.equal(r.stderr,'cloud_registration_timeout\n') }
  finally { f.close() }
})
test('FIFO, symlink, excessive bytes and broad mode cannot block or satisfy the wait', async t => {
  for(const kind of ['fifo','symlink','oversize','mode']) await t.test(kind,async()=>{
    const f=fixture()
    try {
      if(kind==='fifo') await promisify(execFile)('mkfifo',[f.file])
      if(kind==='symlink'){const target=join(f.directory,'target');writeFileSync(target,JSON.stringify(f.body),{mode:0o600});symlinkSync(target,f.file)}
      if(kind==='oversize')writeFileSync(f.file,' '.repeat(1024),{mode:0o600})
      if(kind==='mode'){writeFileSync(f.file,JSON.stringify(f.body),{mode:0o600});chmodSync(f.file,0o644)}
      assert.equal((await run(f.config)).code,1)
    } finally { f.close() }
  })
})
test('missing preloader starts the original fallback once and detaches its output pipes', async () => {
  const f=fixture(), pidFile=join(f.directory,'worker.pid')
  let pid:number|undefined
  try {
    const start=f.notify('const fs=await import("node:fs");fs.writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));await new Promise(r=>setTimeout(r,60000));')
    const r=await run({...f.config,wake:':',start,timeoutMs:1500})
    assert.equal(r.code,0,r.stderr)
    pid=Number(readFileSync(pidFile,'utf8'))
    assert.ok(pid>1);process.kill(pid,0)
  } finally { if(pid)try{process.kill(-pid,'SIGTERM')}catch{};f.close() }
})
test('publication failure closes the watcher and never launches fallback', async () => {
  const f=fixture(), sentinel=join(f.directory,'unexpected')
  try {
    const r=await run({...f.config,publish:'exit 9',wake:':',start:'touch '+quoteShell(sentinel)})
    assert.equal(r.code,1);assert.equal(r.stderr,'cloud_registration_publish_failed\n');assert.equal(existsSync(sentinel),false)
  } finally { f.close() }
})

test('a legacy release with no notification returns to the database gate immediately', async () => {
  const f=fixture(), started=join(f.directory,'legacy-started')
  try {
    rmSync(f.capability)
    const r=await run({...f.config,publish:'touch '+quoteShell(started)})
    assert.equal(r.code,0,r.stderr)
    assert.equal(r.stdout,REGISTRATION_LEGACY+'\n')
    assert.ok(existsSync(started))
    assert.equal(existsSync(f.file),false,'old worker never has to manufacture a new receipt')
  } finally { f.close() }
})
for(const kind of ['worker-sha','installed-sha','ready-sha','unknown-field','writable','symlink','oversize']) {
  test('capability '+kind+' cannot make an old or mismatched release advertise notifications',async()=>{
    const f=fixture()
    const replace=(path:string,value:string,mode=0o444)=>{rmSync(path,{force:true});writeFileSync(path,value,{mode})}
    try {
      if(kind==='worker-sha')replace(f.capability,JSON.stringify({registrationNoticeVersion:1,workerSha:'e'.repeat(40)}))
      if(kind==='installed-sha')replace(join(f.runtimeRoot,'worker-source-sha'),'e'.repeat(40))
      if(kind==='ready-sha')replace(join(f.source,'../worker-ready.sha'),'e'.repeat(40))
      if(kind==='unknown-field')replace(f.capability,JSON.stringify({registrationNoticeVersion:1,workerSha:f.config.workerSha,extra:true}))
      if(kind==='writable')chmodSync(f.capability,0o666)
      if(kind==='symlink'){const target=join(f.directory,'foreign-capability');replace(target,readFileSync(f.capability,'utf8'));rmSync(f.capability);symlinkSync(target,f.capability)}
      if(kind==='oversize')replace(f.capability,' '.repeat(1024))
      const r=await run(f.config)
      assert.equal(r.code,0,r.stderr);assert.equal(r.stdout,REGISTRATION_LEGACY+'\n')
    }finally{f.close()}
  })
}
test('switch and rollback follow the current release capability, never an old global marker', async()=>{
  const f=fixture()
  const replace=(path:string,value:string)=>{rmSync(path,{force:true});writeFileSync(path,value,{mode:0o444})}
  try {
    writeCloudRegistration(f.directory,deviceId,workspaceId,credential)
    assert.ok((await run(f.config)).stdout.includes(REGISTRATION_COMPLETE))
    const oldSource=join(f.runtimeRoot,'releases','2'.repeat(40),'source')
    mkdirSync(oldSource,{recursive:true})
    replace(join(oldSource,'../worker-ready.sha'),'e'.repeat(40))
    replace(join(f.runtimeRoot,'worker-source-sha'),'e'.repeat(40))
    rmSync(join(f.runtimeRoot,'worker'));symlinkSync(oldSource,join(f.runtimeRoot,'worker'))
    assert.equal((await run({...f.config,workerSha:'e'.repeat(40)})).stdout,REGISTRATION_LEGACY+'\n')
    // A leftover registration receipt and the still-existing new release do not
    // make the selected old release support the new notification protocol.
    rmSync(join(f.runtimeRoot,'worker'));symlinkSync(f.source,join(f.runtimeRoot,'worker'))
    replace(join(f.runtimeRoot,'worker-source-sha'),f.config.workerSha)
    assert.ok((await run(f.config)).stdout.includes(REGISTRATION_COMPLETE))
  } finally{f.close()}
})
