import { readFileSync, statSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root=fileURLToPath(new URL('../',import.meta.url))
const routes=[['api/agent','worker'],['api/subscriptions','worker'],['api/subscriptions/callback','worker'],['api/cron/subscriptions','worker'],['v1/devices/[deviceId]/runs/[runId]/subscription','worker'],['api/subscriptions/enrollments','enrollment'],['api/subscriptions/enrollments/handoff','enrollment'],['api/subscriptions/enrollments/bind','enrollment']]
const stage=mkdtempSync(join(tmpdir(),'mikka-worker-artifacts-'))
try {
 for(const [route,kind] of routes){
  const manifest=resolve(root,'.next/server/app',route,'route.js.nft.json')
  const files=JSON.parse(readFileSync(manifest,'utf8')).files.map(p=>resolve(dirname(manifest),p))
  if(files.some(p=>/\/subscription-worker\/(\.cache|\.upstream)\//.test(p)||p.endsWith('/mikka-subscription-fixture')))throw new Error('forbidden build-only artifact')
  const name=`mikka-subscription-${kind}`,relative=`packages/subscription-worker/bin/${name}`,binary=resolve(root,relative)
  if(!files.includes(binary))throw new Error(`missing worker trace: ${route}`)
  const bytes=readFileSync(binary),mode=statSync(binary).mode
  if(bytes.subarray(0,4).toString('hex')!=='7f454c46'||bytes[4]!==2||bytes.readUInt16LE(18)!==62||!(mode&0o111))throw new Error('invalid Linux x64 executable')
  const routeRoot=join(stage,route),target=join(routeRoot,relative);mkdirSync(dirname(target),{recursive:true});copyFileSync(binary,target)
  const result=spawnSync(target,['--version'],{cwd:routeRoot,env:{LANG:'C.UTF-8'},encoding:'utf8',timeout:5000})
  if(result.status!==0||!result.stdout.includes(name))throw new Error('isolated traced binary failed')
 }
 console.log('8 route traces verified; both traced workers started from isolated artifact root; no build-only payloads')
}finally{rmSync(stage,{recursive:true,force:true})}
