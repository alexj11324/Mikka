import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { plan } from './plan.mjs'

const harness=dirname(fileURLToPath(import.meta.url)), repo='/vercel/Mikka', root='/vercel/validation'
const execute=promisify(execFile)
const run=(bin,args,options={})=>execute(bin,args,{timeout:120_000,maxBuffer:8_000_000,...options})
const [, , sha, attempt='final'] = process.argv
// The caller sources the existing private /vercel/validation/test-env.sh.
// Inherit its valid fixture authority without reading, logging or archiving it.
const env={...process.env}
assert.ok(!env.CI,'The local acceptance must not pretend to run in CI')
delete env.FACTORY_TEST_DATABASE_URL
Object.assign(env,{PATH:`${root}/bin:${env.PATH??'/usr/local/bin:/usr/bin:/bin'}`,NODE_ENV:'test',MIKKA_EDITION:'cloud',REQUIRE_DB:'1',MIKKA_LOCAL_TEST_ACCOUNTS:'1',
  FACTORY_MONITOR_TEST_URL:env.E2E_DATABASE_URL,
  BETTER_AUTH_URL:'http://127.0.0.1:3000',E2E_BASE_URL:'http://127.0.0.1:3000',MIKKA_DEV_SKIP_ENV_FILES:'1',NO_COLOR:'1',FORCE_COLOR:'0',TZ:'UTC'})
// Preserve the private fixture password: passwordless replacement URLs disable
// the product's local-test authority even when PostgreSQL itself accepts them.
const {localTestAccountsMode}=await import(pathToFileURL(join(repo,'scripts/test-accounts/database-target.mjs')).href)
assert.ok(localTestAccountsMode(env),'A legitimate isolated local-test environment is required')
for(const key of ['MIKKA_DATABASE_URL','DATABASE_URL','ORVILO_DATABASE_URL'])
  if(env[key]!==undefined)assert.ok(env[key]===env.E2E_DATABASE_URL,'Every configured database must use the same isolated target')
if(sha==='--plan') {
  for(const [bin,args] of [['node',['--version']],['pnpm',['--version']],['ffmpeg',['-version']],['psql',['--version']]])
    console.log(bin+': '+(await run(bin,args,{env})).stdout.split('\n')[0])
  console.log(JSON.stringify(plan(repo,harness,'<OUTPUT>'),null,2));process.exit(0)
}
assert.match(sha??'',/^[a-f0-9]{40}$/);assert.match(attempt,/^[a-z0-9_-]{1,40}$/)
assert.equal((await run('git',['rev-parse','HEAD'],{cwd:repo})).stdout.trim(),sha,'fixed source SHA mismatch')
await run('git',['diff','--quiet','HEAD','--','.',':(exclude)docs/acceptance/issue-1783/**'],{cwd:repo})
const date=new Date().toISOString().slice(0,10), output=join(root,`issue-1783-${date}-${sha.slice(0,12)}-${attempt}`)
await mkdir(output) // Never overwrite a prior failed or successful recording.
const lock=join(root,'issue-1783-recording.lock');await mkdir(lock)
const config={repo,sha,output,stages:plan(repo,harness,output,sha)}
await writeFile(join(output,'config.json'),JSON.stringify(config,null,2)+'\n')
const metadata={codeCommit:sha,codeTree:(await run('git',['rev-parse','HEAD^{tree}'],{cwd:repo})).stdout.trim(),branch:(await run('git',['rev-parse','--abbrev-ref','HEAD'],{cwd:repo})).stdout.trim(),
  startedAt:new Date().toISOString(),environment:{os:'Vercel Sandbox cloud Linux',node:process.version,
    pnpm:(await run('pnpm',['--version'],{env})).stdout.trim(),ffmpeg:(await run('ffmpeg',['-version'])).stdout.split('\n')[0],
    database:(await run('psql',[env.E2E_DATABASE_URL,'-Atc',"SELECT current_database(),inet_server_addr(),current_setting('server_version')"],{env})).stdout.trim(),
    display:'Xvfb 1600x1000x24',capture:'real x11grab terminal execution',externalServices:'synthetic fixtures; no live provider execution'},stages:[]}
let displayProcess
try {
  displayProcess=spawn('Xvfb',['-displayfd','3','-screen','0','1600x1000x24','-nolisten','tcp'],{env,stdio:['ignore','ignore','pipe','pipe']})
  const display=await new Promise((done,fail)=>{displayProcess.once('error',fail);displayProcess.stdio[3].once('data',data=>done(':'+data.toString().trim()));displayProcess.once('exit',()=>fail(Error('Xvfb exited')))})
  const {processCaptureVideo,captureVideoBinaries,CAPTURE_TOOLCHAIN}=await import(pathToFileURL(join(repo,'packages/daemon/src/agents/capture-video.mjs')).href)
  const processorBinaries=await captureVideoBinaries()
  metadata.environment.captureProcessor={toolchain:CAPTURE_TOOLCHAIN.id,binaries:processorBinaries,
    ffmpeg:(await run(processorBinaries.ffmpeg,['-version'])).stdout.split('\n')[0],
    ffprobe:(await run(processorBinaries.ffprobe,['-version'])).stdout.split('\n')[0]}
  for(const stage of config.stages) {
    const raw=join(output,stage.id+'.raw.mp4'), final=join(output,stage.id+'.mp4'), ffmpegLog=join(output,stage.id+'.recorder.txt')
    const recordingStarted=Date.now()
    const recorder=spawn('ffmpeg',['-y','-nostdin','-hide_banner','-loglevel','error','-f','x11grab','-framerate','15','-video_size','1600x1000','-i',display,
      '-c:v','libx264','-preset','ultrafast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart','-progress','pipe:3','-stats_period','0.2',raw],{env,stdio:['ignore','ignore','pipe','pipe']})
    let recordErrors='';recorder.stderr.on('data',data=>{recordErrors+=data})
    const closed=new Promise((done,fail)=>{recorder.once('error',fail);recorder.once('close',code=>done(code))})
    await new Promise((done,fail)=>{let data='';recorder.stdio[3].on('data',chunk=>{data+=chunk;if(/frame=\s*[1-9]/.test(data))done()});recorder.once('error',fail);recorder.once('exit',()=>fail(Error('Recorder exited before first frame')))})
    const terminal=spawn('xterm',['-fa','DejaVu Sans Mono','-fs','20','-geometry','100x30+0+0','-bg','#101722','-fg','#d9e0ec','-sb','-sl','3000',
      '-xrm','XTerm*allowTitleOps: false','-xrm','XTerm*allowWindowOps: false','-title','Mikka #1783 fixed-revision acceptance',
      '-e',process.execPath,join(harness,'stage.mjs'),join(output,'config.json'),stage.id],{env:{...env,DISPLAY:display},stdio:['ignore','ignore','pipe']})
    const exitCode=await new Promise((done,fail)=>{terminal.once('error',fail);terminal.once('close',code=>done(code??1))})
    recorder.kill('SIGINT');await closed;await writeFile(ffmpegLog,recordErrors)
    const receipt=JSON.parse(await readFile(join(output,stage.id+'.json'),'utf8'))
    const rawProbe=JSON.parse((await run('ffprobe',['-v','error','-show_entries','format=duration,size','-of','json',raw])).stdout)
    // No action timing is supplied: retain the entire actual execution timeline.
    // The normal local capture HTTP PUT is limited to 4,000,000 bytes.
    // Keep margin for that exact API while retaining the full timeline.
    const video=await processCaptureVideo(raw,final,{steps:[],maxBytes:3_800_000})
    await run('ffmpeg',['-v','error','-i',final,'-f','null','-'])
    const duration=video.durationMs/1000
    const marks=[['start',Math.min(2,duration/4)],['running',Math.max(0,duration/2)],['result',Math.max(0,duration-2)]]
    for(const [label,seconds] of marks)await run('ffmpeg',['-y','-v','error','-ss',String(seconds),'-i',final,'-frames:v','1',join(output,stage.id+'-'+label+'.png')])
    metadata.stages.push({...receipt,terminalExitCode:exitCode,recordingStartedAt:new Date(recordingStarted).toISOString(),rawProbe,video})
    await writeFile(join(output,'receipt.json'),JSON.stringify(metadata,null,2)+'\n')
    console.log(JSON.stringify({stage:stage.id,exitCode:receipt.exitCode,terminalExitCode:exitCode,videoBytes:video.size,durationMs:video.durationMs,output}))
    if(exitCode!==0 || receipt.exitCode!==0)throw Error('Acceptance stage failed; recording retained')
  }
  metadata.finishedAt=new Date().toISOString();metadata.exitCode=0
} catch(error) {
  metadata.finishedAt=new Date().toISOString();metadata.exitCode=1;metadata.failure=error?.code??error?.name??'Error';process.exitCode=1
  console.error('Acceptance failed; diagnostic recording remains in '+output)
} finally {
  displayProcess?.kill('SIGTERM')
  metadata.files={}
  for(const name of await readdir(output))if(!name.endsWith('.raw.mp4')&&!['receipt.json','config.json'].includes(name)){
    const path=join(output,name);if((await stat(path)).isFile())metadata.files[name]={size:(await stat(path)).size,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}
  }
  await writeFile(join(output,'receipt.json'),JSON.stringify(metadata,null,2)+'\n')
  await mkdir(join(output,'harness'))
  for(const name of ['run.mjs','stage.mjs','plan.mjs','oversize-readback.mjs','register-readback.mjs','review.mjs'])
    await cp(join(harness,name),join(output,'harness',name))
  await rm(lock,{recursive:true,force:true})
}
