export function verifyNativeEvidence(l,source) {
 const must=(v,m)=>{if(!v)throw Error(m)};
 const equal=(a,b,m)=>must(JSON.stringify(a)===JSON.stringify(b),m);
 const sum=o=>Object.values(o).reduce((a,b)=>a+b,0);
 const keys=o=>Object.keys(o).sort();
 const q=l.queryCounts, names=["webLogin","nativeLogin","startup-bundled","startup-hosted"];
 must(l.revision===source.revision&&q.source.revision===source.revision,"source revision mismatch");
 equal(keys(q.windows),[...names].sort(),"window inventory mismatch");
 const scalars=["queryCalls","pgProtocolReceiveBytes","pgProtocolSendBytes","closedConnections","unknownReadings"];
 const opKeys=keys(q.windows.webLogin.checkpoints[0].snapshot.queryOperations), nestedKeys=keys(q.windows.webLogin.checkpoints[0].snapshot.unattributedSources);
 must(opKeys.length===17&&nestedKeys.length===78,"bucket contract changed");
 let checkpoints=0,segments=0,records=0;
 const validateRecord=(r,label)=>{
  records++;
  for(const k of scalars)must(Number.isSafeInteger(r[k])&&r[k]>=0,label+" invalid "+k);
  equal(keys(r.queryOperations),opKeys,label+" operation keys");
  equal(keys(r.unattributedSources),nestedKeys,label+" nested source keys");
  for(const [k,v]of [...Object.entries(r.queryOperations),...Object.entries(r.unattributedSources)])must(Number.isSafeInteger(v)&&v>=0,label+" invalid bucket "+k);
  must(sum(r.queryOperations)===r.queryCalls,label+" operation conservation");
  must(sum(r.unattributedSources)===r.queryOperations.unattributed,label+" nested conservation");
 };
 const validateDelta=(a,b,d,label)=>{
  validateRecord(d,label);
  must(b.endedAt>=a.endedAt&&a.pid===b.pid&&a.startedAt===b.startedAt,label+" snapshot identity/time");
  must(d.startedAt===new Date(a.endedAt).toISOString()&&d.finishedAt===new Date(b.endedAt).toISOString(),label+" exact original boundary");
  must(d.durationMs===b.endedAt-a.endedAt,label+" duration");
  for(const k of scalars)must(d[k]===b[k]-a[k],label+" scalar delta "+k);
  for(const bucket of ["queryOperations","unattributedSources"])for(const k of Object.keys(a[bucket]))must(d[bucket][k]===b[bucket][k]-a[bucket][k],label+" bucket delta "+k);
 };
 const windows={};
 for(const name of names){
  const w=q.windows[name];must(w.status==="complete",name+" incomplete budget");
  const c=w.checkpoints;must(c.length===w.segments.length+1,name+" checkpoint count");
  for(const x of c){validateRecord(x.snapshot,name+"/"+x.phase);checkpoints++;must(x.snapshot.pid===q.source.pid,name+" primary process");}
  for(let i=0;i<w.segments.length;i++){const s=w.segments[i];must(s.phase===c[i+1].phase,name+" phase identity");validateDelta(c[i].snapshot,c[i+1].snapshot,s,name+"/"+s.phase);segments++;}
  validateDelta(c[0].snapshot,c.at(-1).snapshot,w.total,name+"/total");
  for(const k of scalars)must(w.segments.reduce((a,s)=>a+s[k],0)===w.total[k],name+" summed scalar "+k);
  for(const bucket of ["queryOperations","unattributedSources"])for(const k of Object.keys(w.total[bucket]))must(w.segments.reduce((a,s)=>a+s[bucket][k],0)===w.total[bucket][k],name+" summed bucket "+k);
  if(name.startsWith("startup-"))must(w.pair===1,name+" must remain first pair");
  windows[name]={status:w.status,pair:w.pair??null,startedAt:w.total.startedAt,finishedAt:w.total.finishedAt,queryCalls:w.total.queryCalls,segments:w.segments.map(s=>({phase:s.phase,queryCalls:s.queryCalls})),unknownReadings:w.total.unknownReadings};
 }
 must(checkpoints===12&&segments===8&&records===24,"record counts changed");
 must(l.samples.length>=10&&l.samples[0].pair===1&&l.samples[0].mode==="bundled"&&l.samples[1].pair===1&&l.samples[1].mode==="hosted","first startup sample pair");
 const di=q.rpcActions.queryDiagnostics;
 equal(di.columns,["queryCalls","context","statement","scope"],"diagnostic column contract");
 must(di.capture.overflow===false&&di.capture.droppedQueries===0,"diagnostic overflow");
 const diagnostics={status:di.status,capture:di.capture,windows:{}};
 let diagnosticCount=0;
 for(const name of names){
  const d=di.windows[name],w=q.windows[name],a=w.checkpoints[0].snapshot.queryCalls,b=w.checkpoints.at(-1).snapshot.queryCalls;
  must(d.fromQueryCalls===a&&d.toQueryCalls===b&&d.expectedQueries===b-a,"diagnostic range "+name);
  must(d.capturedQueries===d.queries.length&&d.queries.length===b-a&&d.uncapturedQueries===0,"diagnostic count "+name);
  const op=Object.fromEntries(opKeys.map(k=>[k,0])),nested=Object.fromEntries(nestedKeys.map(k=>[k,0]));
  let unknownContext=0,unknownStatement=0;
  for(let i=0;i<d.queries.length;i++){
   const row=d.queries[i];must(row.length===4&&row[0]===a+i+1,"diagnostic ordinal "+name);
   const c=di.contexts[row[1]],s=di.statements[row[2]],scope=di.scopeKeys[row[3]];
   must(c&&s&&typeof scope==="string","diagnostic dictionary "+name);
   if(c.status!=="known")unknownContext++;
   if(s.status!=="known")unknownStatement++;
   if(Object.hasOwn(nested,scope)){nested[scope]++;op.unattributed++;}
   else {must(Object.hasOwn(op,scope)&&scope!=="unattributed","diagnostic scope "+name);op[scope]++;}
  }
  equal(op,Object.fromEntries(opKeys.map(k=>[k,w.total.queryOperations[k]])),"diagnostic operation buckets "+name);
  equal(nested,Object.fromEntries(nestedKeys.map(k=>[k,w.total.unattributedSources[k]])),"diagnostic nested buckets "+name);
  must(unknownContext===d.unknownContextQueries&&unknownStatement===d.unknownStatementQueries,"diagnostic unknowns "+name);
  diagnostics.windows[name]={status:d.status,reasons:d.reasons,queries:d.queries.length,unknownContextQueries:unknownContext,unknownStatementQueries:unknownStatement,uncapturedQueries:d.uncapturedQueries};
  diagnosticCount+=d.queries.length;
 }
 const rpc={physicalDuplicateRecords:q.rpcActions.duplicateRecords,physicalConflicts:q.rpcActions.conflictingInvocations,logicalDuplicateRecords:q.rpcActions.logical.duplicateRecords,logicalConflicts:q.rpcActions.logical.conflictingInvocations,windows:{}};
 for(const name of names){
  rpc.windows[name]={};
  for(const[label,table]of [["physical",q.rpcActions],["logical",q.rpcActions.logical]]){
   const w=table.windows[name],starts=w.actions.reduce((a,x)=>a+x.startedInWindow,0),phaseStarts=w.segments.reduce((a,s)=>a+s.actions.reduce((b,x)=>b+x.startedInWindow,0),0);
   must(starts===phaseStarts,"RPC start partition "+name+"/"+label);
   rpc.windows[name][label]={status:w.status,started:starts,completed:w.actions.reduce((a,x)=>a+x.completedInWindow,0),actions:w.actions,segments:w.segments};
  }
 }
 const cleanup={nativeCleaned:l.nativeCleanup?.cleaned,workspaceNameRestoredFlag:l.workspaceNameCleanup?.restored,initialOwnerMatchesSealedBaseline:l.workspaceNameCleanup?.initialOwnerMatchesSealedBaseline,ownerMatchesSealedBaselineAfter:l.workspaceNameCleanup?.ownerMatchesSealedBaseline,peerMatchesSealedBaselineAfter:l.workspaceNameCleanup?.peerMatchesSealedBaseline};
 return {schema:1,kind:"root-independent-current-native-original-reconciliation",source,
  checks:{checkpoints,segments,totals:4,records,operationsPerRecord:opKeys.length,nestedSourcesPerRecord:nestedKeys.length,monotonicCounters:true,allScalarAndBucketDeltasMatch:true,allTotalsEqualSegments:true,firstPairPreserved:true,totalDiagnosticQueries:diagnosticCount,diagnosticOrdinalAndBucketReconciliation:true},
  windows,diagnostics,rpc,rawColdStartSummary:l.coldStart,cleanup,
  budgetPassed:windows.nativeLogin.queryCalls<=windows.webLogin.queryCalls&&windows["startup-bundled"].queryCalls<=windows["startup-hosted"].queryCalls,
  productionAccepted:false,boundaries:["Calculated from the complete original lifecycle JSON, with no edited snapshots, omitted phases, subtractions or selected later startup pairs.","Diagnostic unknown context/statement counts remain incomplete; unknownReadings=0 is a different measure.","RPC start partitions are checked; crossing and status observations are retained without additive reinterpretation.","workspaceNameCleanup.restored is preserved independently from sealed-baseline-after and cleanup stages.","This is packaged Native/Web query-budget evidence for this exact checkout, not actual ACME subscription or PostHog render acceptance."]};
}
