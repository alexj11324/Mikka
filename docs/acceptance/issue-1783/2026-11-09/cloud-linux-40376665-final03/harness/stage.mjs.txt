import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [configPath, stageId] = process.argv.slice(2)
const config = JSON.parse(readFileSync(configPath,'utf8')), stage = config.stages.find(item=>item.id===stageId)
assert.ok(stage)
const log = join(config.output,stage.id+'.txt'), receiptPath=join(config.output,stage.id+'.json')
const startedAt=new Date().toISOString(), origin=Date.now(), results=[]
const clean = value => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
  .replace(/((?:authorization|cookie|set-cookie|password|client_secret|access_token|refresh_token|session_token)\s*[=:]\s*)([^\r\n]+)/gi,'$1[REDACTED]')
  .replace(/\b(?:Bearer\s+\S+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|(?:mikka_pat_|orv_|mkw_|mka_|mkr_|mkp_)[A-Za-z0-9_-]+)\b/g,'[REDACTED]')
const say = value => { const text=clean(value); process.stdout.write(text); appendFileSync(log,text) }
const fixed = () => {
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:config.repo,encoding:'utf8'}).trim(),config.sha)
  execFileSync('git',['diff','--quiet','HEAD','--','.',':(exclude)docs/acceptance/issue-1783/**'],{cwd:config.repo})
}
function counts(text, kind) {
  if (kind==='node') {
    const count = name => Number(text.match(new RegExp('(?:^|\\n)[^\\n]*?\\b'+name+' (\\d+)(?:\\n|$)'))?.[1] ?? NaN)
    return {total:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped')}
  }
  if (kind==='vitest') {
    const line=text.split('\n').find(line=>/^\s*Tests\s/.test(line)) ?? ''
    return { total:Number(line.match(/\((\d+)\)/)?.[1] ?? NaN), passed:Number(line.match(/(\d+) passed/)?.[1]??0),
      failed:Number(line.match(/(\d+) failed/)?.[1]??0), skipped:Number(line.match(/(\d+) skipped/)?.[1]??0) }
  }
  return null
}
say(`Mikka issue #1783 | ${stage.title}\nRevision: ${config.sha}\nStarted: ${startedAt}\nCloud Linux / real isolated PostgreSQL / synthetic fixtures\nNo live model or external GitHub acceptance is claimed.\n\n`)
await delay(1200)
let exitCode=0
try {
  fixed()
  for(const [index, command] of stage.commands.entries()) {
    const start=Date.now(), commandStart=new Date().toISOString()
    say(`\n[${index+1}/${stage.commands.length}] $ ${[command.bin,...command.args].join(' ')}\n`)
    const child=spawn(command.bin,command.args,{cwd:command.cwd,env:{...process.env,NO_COLOR:'1',FORCE_COLOR:'0'},stdio:['ignore','pipe','pipe']})
    let output=''
    const receive=data=>{const text=clean(data.toString());output+=text;say(text)}
    child.stdout.on('data',receive);child.stderr.on('data',receive)
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve(code??(signal?128:1)))})
    const summary=counts(output,command.tests)
    const accepted=code===0 && (!summary || Object.values(summary).every(Number.isFinite) && summary.total>0 && summary.failed===0 && summary.skipped===0)
    results.push({command:[command.bin,...command.args],cwd:command.cwd,startedAt:commandStart,finishedAt:new Date().toISOString(),
      atMs:Date.now()-origin,durationMs:Date.now()-start,exitCode:code,tests:summary,accepted})
    say(`\nCommand exit: ${code}; ${accepted?'PASS':'FAIL'}${summary?'; '+JSON.stringify(summary):''}\n`)
    await delay(1800)
    if(!accepted) {exitCode=1;break}
    fixed()
  }
} catch(error) {exitCode=1;say(`\nHARNESS FAILURE: ${error?.code??error?.name??'Error'}\n`)}
const finishedAt=new Date().toISOString()
say(`\n${stage.title}\nRevision: ${config.sha}\nRESULT: ${exitCode===0?'PASS':'FAIL'} | commands ${results.length}/${stage.commands.length}\nFinished: ${finishedAt}\n`)
writeFileSync(receiptPath,JSON.stringify({id:stage.id,title:stage.title,codeCommit:config.sha,startedAt,finishedAt,exitCode,results,finalScreenAtMs:Date.now()-origin+1800},null,2)+'\n')
await delay(3500)
process.exitCode=exitCode
