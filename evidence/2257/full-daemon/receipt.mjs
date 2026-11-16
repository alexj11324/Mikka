import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root=resolve(process.argv[2]), dir=join(root,'run/case')
const report=existsSync(join(dir,'proof.json'))?JSON.parse(readFileSync(join(dir,'proof.json'),'utf8')):{success:false,checks:[],diagnostic:{stage:'preflight'}}
const modelDir = process.env.E_MODEL_QA_DIR ?? dir
const deviceDir = process.env.E_DEVICE_DATA_DIR ?? join(dir, 'daemon')
const jsonLines = name => {
  try { return readFileSync(join(modelDir, name), 'utf8').trim().split('\n').filter(Boolean) }
  catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) return null; throw error }
}
const safeName=v=>typeof v==='string'&&/^[\w.-]{1,75}$/.test(v)?v:undefined
const counts={}
for(const file of ['requests.jsonl','results.jsonl','claude-requests.jsonl','claude-results.jsonl','decisions.jsonl']) counts[file]=jsonLines(file)?.length ?? null
const logPath=join(deviceDir,'logs/daemon.log')
const readDeviceFile = path => {
  try { return readFileSync(path, 'utf8') }
  catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) return null; throw error }
}
const deviceLog = readDeviceFile(logPath)
const logs=deviceLog?deviceLog.split('\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}}):[]
const heartbeatFailures=logs.filter(l=>l.level>=40).slice(-12).map(l=>({level:l.level,reason:safeName(l.err?.code),status:l.err?.status,summary:typeof l.msg==='string'&&/^[a-zA-Z ._-]{1,65}$/.test(l.msg)?l.msg:undefined}))
const journalFile=readDeviceFile(join(deviceDir,'runs.json'))
const journal=journalFile?JSON.parse(journalFile).runs:{}
const recognizedErrors = ['Repository unavailable','Repository identity','policy','unable to access','provider','authentication','Claude','Codex','MCP','ENOENT','EACCES','certificate','not supported','snapshot','refused','Could not resolve','Connection refused','could not read Username','transport','signature','model','macaroon','worktree','branch','Credential','GitHub','Repository','checkout','tool approval']
const journals=Object.values(journal).map(j=>({state:safeName(j.state),stopReason:safeName(j.stopReason),markers:recognizedErrors.filter(s=>String(j.error??'').toLowerCase().includes(s.toLowerCase())),seq:j.lastSeq,withheld:!!j.credentialWithheld,session:!!j.sessionId}))
const receipt={...report,journals,journalReadable:journalFile !== null,source:process.env.PUBLIC_SOURCE,evidenceRevision:process.env.GITHUB_SHA,run:process.env.GITHUB_RUN_ID,counts,heartbeats:heartbeatFailures,model:'SmolLM2-135M-Instruct-Q4_K_M',weightSha256:'2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d',paidSubscription:false}
const text=JSON.stringify(receipt,null,2)+'\n'
if(/(?:mkg_|orv_)[A-Za-z0-9_-]{25,}|BEGIN [A-Z ]*PRIVATE KEY|postgres(?:ql)?:\/\/|(?:bearer|set-cookie):|(?:session_token|sessionToken)=/i.test(text))throw Error('unsanitized receipt')
writeFileSync(join(root,'public-receipt.json'),text,{mode:0o600})
