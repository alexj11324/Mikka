import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const guard=await import(pathToFileURL(join(process.env.RUNNER_TEMP,'diagnostic-prepare-guard.mjs')).href)
const {localGuard,currentMain,boundedFetch,saveJson,saveAudit,loadAudit,safeCode,originalPath,windowGuard}=guard
const output=join(process.env.RUNNER_TEMP,'diagnostic-window.json')
let latest=null,called=false,postMainPassed=false,callerFailed=false
const save=async report=>{latest=structuredClone(report);await saveJson(output,latest)}
try{
  await loadAudit()
  const {helper,driver}=await localGuard()
  await currentMain('before_prepare',true)
  windowGuard(true)
  const reuse=helper.readOriginalBot(await readFile(originalPath))
  called=true
  const report=await helper.prepareWindow({env:process.env,helpers:driver,reuse,fetchImpl:boundedFetch,save})
  await save(report)
}catch(error){
  callerFailed=true
  guard.audit.callerCode=safeCode(error)
}finally{
  if(called){
    try{await currentMain('after_prepare');postMainPassed=true}
    catch(error){
      callerFailed=true;guard.audit.postMainCode=safeCode(error)
      if(latest){
        latest.statusBeforePostMainGuard=latest.status
        latest.status='failed'
        latest.postMainGuard={status:'failed',code:safeCode(error)}
        latest.recovery={...latest.recovery,preserveHelperRef:true,repeatPreparationAutomatically:false,
          windowWriteMayExist:latest.window?.writeAttempted===true}
      }
    }
  }
  if(latest)await saveJson(output,latest)
  guard.audit.status=!callerFailed&&postMainPassed&&latest?.status==='prepared'?'prepared':'failed'
  guard.audit.prepareCalled=called
  guard.audit.postMainPassed=postMainPassed
  guard.audit.windowWriteMayExist=latest?.window?.writeAttempted===true
  guard.audit.repeatPreparationAutomatically=false
  guard.audit.finishedAt=new Date().toISOString()
  await saveAudit()
  if(guard.audit.status!=='prepared')process.exitCode=1
}
