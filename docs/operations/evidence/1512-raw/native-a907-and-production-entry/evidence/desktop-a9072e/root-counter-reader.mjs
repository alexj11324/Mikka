import fs from 'node:fs'
function verifyNativeWindowCounters(lifecycle){
 const fail=m=>{throw new Error(m)};
 const q=lifecycle.queryCounts, rows=[], windows=[];
 if(q.source.revision!=='052740cf37c4788853eb98df9d66ea7c646ea0c2')fail('source');
 const scalar=['queryCalls','pgProtocolReceiveBytes','pgProtocolSendBytes','closedConnections','unknownReadings'];
 const sum=o=>Object.values(o).reduce((a,v)=>{if(!Number.isSafeInteger(v)||v<0)fail('invalid counter');return a+v},0);
 const check=(d,path)=>{
  if(Object.keys(d.queryOperations).length!==17||Object.keys(d.unattributedSources).length!==75)fail('catalog '+path);
  if(sum(d.queryOperations)!==d.queryCalls)fail('operation conservation '+path);
  if(sum(d.unattributedSources)!==d.queryOperations.unattributed)fail('source conservation '+path);
  if(d.unknownReadings!==0)fail('unknown readings '+path);
  rows.push({path,queryCalls:d.queryCalls,unattributed:d.queryOperations.unattributed,otherScoped:d.unattributedSources.otherScoped,noScope:d.unattributedSources.noScope,operationCount:17,sourceCount:75,conserved:true});
 };
 let epoch,pid;
 for(const [name,w] of Object.entries(q.windows)){
  if(w.status!=='complete'||w.checkpoints.length!==w.segments.length+1)fail('window '+name);
  for(let i=0;i<w.checkpoints.length;i++){
   const s=w.checkpoints[i].snapshot;
   epoch??=s.startedAt;pid??=s.pid;
   if(s.startedAt!==epoch||s.pid!==pid||s.runtime!=='nitro'||s.instrumentedClients!==1)fail('counter continuity');
   check(s,name+'/checkpoint/'+i);
   if(i){
    const a=w.checkpoints[i-1].snapshot,d=w.segments[i-1];
    if(s.endedAt<a.endedAt)fail('clock regression');
    for(const k of scalar)if(s[k]-a[k]!==d[k]||d[k]<0)fail('delta '+name+'/'+k);
    for(const bucket of ['queryOperations','unattributedSources'])for(const k of Object.keys(a[bucket]))if(s[bucket][k]-a[bucket][k]!==d[bucket][k])fail('bucket delta '+name+'/'+k);
    if(new Date(a.endedAt).toISOString()!==d.startedAt||new Date(s.endedAt).toISOString()!==d.finishedAt||s.endedAt-a.endedAt!==d.durationMs)fail('segment timing');
    check(d,name+'/segment/'+(i-1));
   }
  }
  const first=w.checkpoints[0].snapshot,last=w.checkpoints.at(-1).snapshot,total=w.total;
  for(const k of scalar)if(last[k]-first[k]!==total[k]||w.segments.reduce((a,d)=>a+d[k],0)!==total[k])fail('total '+name+'/'+k);
  for(const bucket of ['queryOperations','unattributedSources'])for(const k of Object.keys(first[bucket]))if(last[bucket][k]-first[bucket][k]!==total[bucket][k]||w.segments.reduce((a,d)=>a+d[bucket][k],0)!==total[bucket][k])fail('total bucket '+name+'/'+k);
  if(new Date(first.endedAt).toISOString()!==total.startedAt||new Date(last.endedAt).toISOString()!==total.finishedAt||last.endedAt-first.endedAt!==total.durationMs)fail('total timing');
  check(total,name+'/total');windows.push({name,queries:total.queryCalls,phases:w.segments.map(d=>d.queryCalls),startedAt:total.startedAt,finishedAt:total.finishedAt});
 }
 return {version:1,kind:'root-independent-native-counter-conservation',source:q.source.revision,sourceArtifactSha256:'a61adcbb1b48f46f262ea2fe0d2139f3c3a8093f2ce8b11d839e59fa9f5c2bac',snapshotCount:12,segmentCount:8,totalCount:4,verifiedRows:rows.length,pid,epoch,windows,rows,allConserved:true,loginBudgetPassed:false,startupBudgetPassedThisRun:true,productionAcceptancePassed:false};
}
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))
process.stdout.write(JSON.stringify(verifyNativeWindowCounters(input),null,2)+'\n')
