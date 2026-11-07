import { readFileSync } from 'node:fs'
const life=JSON.parse(readFileSync(process.argv[2], 'utf8'))
const rows=[],windows=[]
function walk(v,path){if(!v||typeof v!=='object')return
 if(typeof v.queryCalls==='number'&&v.queryOperations&&v.unattributedSources){
 const a=Object.values(v.queryOperations),b=Object.values(v.unattributedSources)
 rows.push({path,queryCalls:v.queryCalls,operations:a.length,sources:b.length,operationSum:a.reduce((x,y)=>x+y,0),sourceSum:b.reduce((x,y)=>x+y,0),unattributed:v.queryOperations.unattributed,valid:a.length===17&&b.length===78&&a.every(Number.isSafeInteger)&&b.every(Number.isSafeInteger)&&a.reduce((x,y)=>x+y,0)===v.queryCalls&&b.reduce((x,y)=>x+y,0)===v.queryOperations.unattributed})
 }
 if(Array.isArray(v.checkpoints)&&v.checkpoints.length>=2&&v.checkpoints.every(c=>c.snapshot?.queryOperations)){
 const first=v.checkpoints[0].snapshot,last=v.checkpoints.at(-1).snapshot,segments=v.segments??[]
 windows.push({path,status:v.status,checkpointCount:v.checkpoints.length,segmentCount:segments.length,queryCalls:last.queryCalls-first.queryCalls,segmentQueries:segments.reduce((x,s)=>x+s.queryCalls,0),pid:first.pid,pidConsistent:v.checkpoints.every(c=>c.snapshot.pid===first.pid),unknownReadingsZero:v.checkpoints.every(c=>c.snapshot.unknownReadings===0),unattributed:last.queryOperations.unattributed-first.queryOperations.unattributed,otherScoped:last.unattributedSources.otherScoped-first.unattributedSources.otherScoped,noScope:last.unattributedSources.noScope-first.unattributedSources.noScope,allOperationSegmentsConserve:Object.keys(first.queryOperations).every(k=>segments.reduce((x,s)=>x+s.queryOperations[k],0)===last.queryOperations[k]-first.queryOperations[k]),allSourceSegmentsConserve:Object.keys(first.unattributedSources).every(k=>segments.reduce((x,s)=>x+s.unattributedSources[k],0)===last.unattributedSources[k]-first.unattributedSources[k])})
 }
 for(const[k,x]of Object.entries(v))walk(x,path?path+'.'+k:k)
}
walk(life,'')
const valid=rows.length===24&&windows.length===4&&rows.every(r=>r.valid)&&windows.every(w=>w.queryCalls===w.segmentQueries&&w.allOperationSegmentsConserve&&w.allSourceSegmentsConserve&&w.pidConsistent&&w.unknownReadingsZero)
process.stdout.write(JSON.stringify({rows,windows,valid},null,2)+'\n')
if(!valid)process.exitCode=1
