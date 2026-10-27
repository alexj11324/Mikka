#!/usr/bin/env node
import { loadAgentDirectory } from '../lib/agent-kit/loader'
import { digest, exportDefinition } from '../lib/agent-kit/definition'
import { CORE_EVAL_CASES, runEvalSuite } from '../lib/agent-kit/evals'

const [command,directory='agents/default']=process.argv.slice(2)
try {
  if(!['validate','export','fixture-eval'].includes(command ?? '')) throw new Error('Usage: pnpm exec tsx scripts/agent-kit.mts <validate|export|fixture-eval> [agent-directory]')
  const definition=await loadAgentDirectory(directory)
  if(command==='export') console.log(exportDefinition(definition))
  else if(command==='validate') console.log(JSON.stringify({ valid:true,id:definition.id,digest:digest(definition),tools:definition.tools.length,skills:definition.skills.length }))
  else {
    const report=await runEvalSuite({definition,cases:CORE_EVAL_CASES,mode:'fixture',run:async testCase=>({text:testCase.expectedOutcome==='answered'?'Synthetic fixture: 2026-01-15':testCase.expectedOutcome==='blocked'?'Search unavailable.':'Awaiting approval.',outcome:testCase.expectedOutcome,tools:testCase.requiredTools.map(name=>({name,outcome:testCase.expectedOutcome==='blocked'?'error':testCase.expectedOutcome==='approval_required'?'approval_pending':'ok',authorized:false,effectPerformed:false}))})})
    console.log(JSON.stringify({label:'Framework smoke test only; not model capability evidence or activation approval.',report},null,2))
    if(report.errors || report.passed!==report.total) process.exitCode=1
  }
} catch(error) {
  console.error(error instanceof Error ? error.message : 'Agent definition command failed')
  process.exitCode=1
}
