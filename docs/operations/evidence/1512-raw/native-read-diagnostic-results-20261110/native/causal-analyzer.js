function analyzeNativeReadDiagnostics(lifecycle, protocol) {
  const report = {
    schema: "mikka.issue1512.renderer-read-causality.v1",
    sourceRevision: lifecycle.revision ?? null,
    capture: { present: !!lifecycle.readDiagnostics, records: 0, completeRecords: 0, incompleteRecords: 0 },
    records: [], realms: [], issues: [],
    limitations: [
      "Renderer integer IDs and same-realm sequence/barriers supply causal associations. No nearest-time joins are performed.",
      "performance.timeOrigin+performanceNow is retained only as an epoch projection, not a backend SQL attribution or calibrated cross-process timestamp.",
      "A complete closed prefix can still contain in-flight reads and unmapped non-SWR actions. It does not establish complete HTTP/SQL coverage.",
      "Bundled launch and its initial document precede beginQueryWindow(nativeLogin); authenticated-profile collection follows post-window device preparation. The prefix can contain both pre-window and post-window events and is not the ordinary-login SQL window.",
      "Revalidation-decision counts are branches1,2,3,8,12 only; branch11 and loop continuations7,13 do not themselves issue a read.",
      "Subscription identities persist across connection generations; a first add can precede connect++generation, and close can follow a generation increment.",
      "No count is subtracted from the existing query budgets and no missing association is invented.",
      "observedChannelIdsForKey is the entire realm's ever-observed key/channel set, including future or removed subscriptions and without cache identity; it is not a direct channel attribution for a read.",
      "matchingPriorFlushRows and matchingPriorInvalidationRows are all earlier exact-key/after candidates; pendingAfter=max can merge obligations. They do not identify a unique trigger or complete ancestor chain.",
      "Realm summaries and completedAtCut refer to the deduplicated union's final observed cut, not independent per-phase counts. Record-specific capture metadata remains separate.",
      "Any cross-record conflicting tuple under the same realm/seq blocks causal derivation for that realm; the frozen original records remain the source of truth."
    ]
  };
  if (!protocol || typeof protocol.reviewReadDiagnosticCollection !== "function" || typeof protocol.validateReadDiagnosticCollection !== "function" || typeof protocol.validateReadDiagnosticDump !== "function") throw new Error("EXACT_PROTOCOL_REQUIRED");
  const rd = lifecycle.readDiagnostics;
  if (!rd || rd.version !== 1 || !Array.isArray(rd.records)) { report.issues.push({kind:"missing-diagnostics"}); return report; }
  const allRealms = new Map();
  const issue = (kind, fields={}) => report.issues.push({kind,...fields});
  const actions = ["other","desktop.bootstrap","desktop.session","desktop.readBatch","task-runs.pollTaskRuns","coordinator.pollBotChatSummaries","bots.pollBots","teams.listTeams","team-relations.listProjectTeams","projects.listProjects","coordinator.syncCoordinatorChat","issues.syncIssueList","task-runs.syncThreadList","execution-settings.getBotModelMenu","workspace.switchWorkspace"];
  const kindNames = ["other","workspace_settings","task_run_list","bot_chat_list","bot_chat","issue_list","thread_list","bot_list","project","group_list"];
  const freshNames = ["none","no_read_revalidate","captured_not_notified_revalidate","existing_read_before_boundary_revalidate","wait_read_began_after","wait_pending_dispatch_after","current_lifetime_retired","revoked_new_read_continue","revoked_revalidate","failed_propagate_same_error","committed_applied_accepted_reuse","accepts_rejected","no_covering_next_read_revalidate","new_read_continue"];
  const channelNames = ["none","construct","connect_begin","socket_open","live_ready","close","presence_ack"];
  const revalidating = new Set([1,2,3,8,12]);
  for (let index=0; index<rd.records.length; index++) {
    const entry=rd.records[index], label={index,phase:entry.phase,mode:entry.mode,launch:entry.launch};
    report.capture.records++;
    const rawValid=protocol.validateReadDiagnosticCollection(entry.raw);
    const currentValid=entry.current===null || protocol.validateReadDiagnosticDump(entry.current);
    let replay;
    if (rawValid && currentValid) replay=protocol.reviewReadDiagnosticCollection(entry.raw,entry.current);
    else replay={status:"incomplete",reasons:[14],expectedDocuments:0,realms:[]};
    const rr={...label,exportedStatus:entry.status,replayedStatus:replay.status,reasons:replay.reasons,expectedDocuments:replay.expectedDocuments,realms:[]};
    if (replay.status==="complete") report.capture.completeRecords++; else report.capture.incompleteRecords++;
    if (rawValid && currentValid && (entry.status!==replay.status || JSON.stringify(entry.reasons)!==JSON.stringify(replay.reasons))) issue("projection-status-mismatch",label);
    if (rawValid && currentValid && Array.isArray(entry.realms) && JSON.stringify(entry.realms)!==JSON.stringify(replay.realms)) issue("projection-realms-mismatch",label);
    if (!rawValid || !currentValid) issue("invalid-raw-input",label);
    for (const realm of replay.realms) {
      const key=[entry.mode,entry.launch,...realm.realm,realm.timeOrigin].join(":");
      const identity={mode:entry.mode,launch:entry.launch,realm:[...realm.realm],timeOrigin:realm.timeOrigin};
      let aggregate=allRealms.get(key);
      if (!aggregate) { aggregate={...identity,records:[],rows:new Map(),captureIncompleteRecords:[],conflictingPrefix:false}; allRealms.set(key,aggregate); }
      aggregate.records.push(index);
      if (replay.status!=="complete") aggregate.captureIncompleteRecords.push(index);
      for (const row of realm.rows) {
        const prior=aggregate.rows.get(row[0]);
        if (prior && JSON.stringify(prior)!==JSON.stringify(row)) { aggregate.conflictingPrefix=true; issue("conflicting-prefix-row",{...identity,seq:row[0],records:aggregate.records}); }
        else if (!prior) aggregate.rows.set(row[0],[...row]);
      }
      rr.realms.push({...identity,current:realm.current,dumps:realm.dumps,recorded:realm.recorded,through:realm.through,dropped:realm.dropped,rows:realm.rows.length,lastSeq:realm.lastSeq});
    }
    report.records.push(rr);
  }
  for (const aggregate of allRealms.values()) {
    const identity={mode:aggregate.mode,launch:aggregate.launch,realm:aggregate.realm,timeOrigin:aggregate.timeOrigin};
    const rows=[...aggregate.rows.values()].sort((a,b)=>a[0]-b[0]);
    if (aggregate.conflictingPrefix) {
      report.realms.push({...identity,records:aggregate.records,analysisBlocked:true,reason:"conflicting-prefix-row",retainedDistinctSequenceCount:rows.length});
      continue;
    }
    const reads=new Map(), logical=new Map(), requests=new Map(), proofs=new Map(), channels=new Map();
    const decisions=[], subscriptions=[], invalidations=[], flushes=[], incoming=[], scopeResets=[], unresolved=[];
    const ref = row => ({seq:row[0],ms:row[1],epochProjectionMs:aggregate.timeOrigin+row[1]});
    const add = (map,id,value,kind,row) => {
      if (map.has(id)) issue("duplicate-identity",{...identity,kind,id,seq:row[0]});
      else map.set(id,value);
    };
    const appendRead = (id,field,value,row) => {
      const read=reads.get(id);
      if (read) read[field].push(value);
      else unresolved.push({event:row[2],seq:row[0],readId:id,missing:"readBegin"});
    };
    const channel = id => {
      if (!channels.has(id)) channels.set(id,{id,states:[],subscriptions:[],invalidations:[],flushes:[],incoming:[]});
      return channels.get(id);
    };
    for (const row of rows) {
      const [seq,ms,event,...v]=row, at=ref(row);
      if (event===2) add(reads,v[0],{id:v[0],cacheId:v[1],keyId:v[2],began:v[3],begin:at,captures:[],notifies:[],revokes:[],receives:[],settles:[],accepts:[],actionIds:[],requestIds:[],freshRows:[]}, "read",row);
      else if (event===3) appendRead(v[0],"captures",at,row);
      else if (event===4) appendRead(v[0],"notifies",{...at,barrier:v[1]},row);
      else if (event===5) appendRead(v[0],"revokes",{...at,reason:v[1]},row);
      else if (event===6) add(proofs,v[0],{id:v[0],barrier:v[1],...at,requestIds:[]}, "proof",row);
      else if (event===7) appendRead(v[0],"receives",{...at,receivedProofBarrier:v[1],effectiveBegan:v[2]},row);
      else if (event===8) appendRead(v[0],"settles",{...at,outcome:v[1],effectiveBegan:v[2],accepted:!!v[3],superseded:!!v[4]},row);
      else if (event===9) appendRead(v[0],"accepts",at,row);
      else if (event===10) add(logical,v[0],{id:v[0],readId:v[1],code:v[2],action:actions[v[2]],created:at,enqueues:[],requestIds:[]}, "action",row);
      else if (event===11) {
        const action=logical.get(v[0]);
        if (action) action.enqueues.push(at); else unresolved.push({event,seq,actionId:v[0],missing:"action"});
      } else if (event===12) add(requests,v[0],{id:v[0],code:v[1],action:actions[v[1]],proofId:v[2],endpoint:v[3],dispatch:at,actionLinks:[],responses:[]}, "request",row);
      else if (event===13) {
        const request=requests.get(v[0]);
        if (request) request.actionLinks.push({actionId:v[1],...at}); else unresolved.push({event,seq,requestId:v[0],actionId:v[1],missing:"request"});
      } else if (event===14) {
        const request=requests.get(v[0]);
        if (request) request.responses.push({...at,status:v[1]}); else unresolved.push({event,seq,requestId:v[0],missing:"request"});
      } else if (event===15) {
        const branch=v[4], decision={...at,cacheId:v[0],keyId:v[1],after:v[2],readId:v[3],branch,name:freshNames[branch],callsRevalidate:revalidating.has(branch)};
        if (branch<=5) { decision.began=v[5]; decision.pendingDispatchAt=v[6]; }
        else if ([7,13].includes(branch)) decision.nextReadId=v[5];
        else if ([10,11,12].includes(branch)) decision.effectiveBegan=v[5];
        decisions.push(decision);
        if (v[3]) {
          const read=reads.get(v[3]);
          if (read) { read.freshRows.push(seq); if (read.cacheId!==v[0]||read.keyId!==v[1]) issue("fresh-read-key-mismatch",{...identity,seq,readId:v[3]}); }
          else unresolved.push({event,seq,readId:v[3],missing:"readBegin"});
        }
      } else if (event===16) {
        const state={...at,state:v[1],name:channelNames[v[1]],generation:v[2]};
        if ([4,6].includes(v[1])) state.coverageAfter=v[3];
        if (v[1]===5) state.wasConnected=!!v[3];
        channel(v[0]).states.push(state);
      } else if (event===17) {
        const sub={...at,channelId:v[0],generation:v[1],subscriptionId:v[2],keyId:v[3],kindCode:v[4],kind:kindNames[v[4]],operation:v[5]===1?"add":"remove"};
        subscriptions.push(sub); channel(v[0]).subscriptions.push(sub);
      } else if (event===18) {
        const inv={...at,channelId:v[0],generation:v[1],keyId:v[2],incomingAfter:v[3],pendingAfter:v[4],immediate:!!v[5],unsupportedOnly:!!v[6],revision:v[7],cause:v[8]};
        invalidations.push(inv); channel(v[0]).invalidations.push(inv);
      } else if (event===19) {
        const flush={...at,channelId:v[0],generation:v[1],keyId:v[2],after:v[3],unconditional:!!v[4],waitCount:v[5]};
        flushes.push(flush); channel(v[0]).flushes.push(flush);
      } else if (event===20) scopeResets.push({...at,generation:v[0],retiredPendingCount:v[1]});
      else if (event===21) {
        const inc={...at,channelId:v[0],generation:v[1],kindCode:v[2],kind:kindNames[v[2]],after:v[3],revision:v[4]};
        incoming.push(inc); channel(v[0]).incoming.push(inc);
      }
    }
    for (const request of requests.values()) {
      if (request.proofId) {
        const proof=proofs.get(request.proofId);
        if (proof) {
          proof.requestIds.push(request.id); request.proofBarrier=proof.barrier;
          if (proof.seq>=request.dispatch.seq) issue("proof-not-before-dispatch",{...identity,requestId:request.id});
        } else unresolved.push({requestId:request.id,proofId:request.proofId,missing:"proof"});
      }
      for (const link of request.actionLinks) {
        const action=logical.get(link.actionId);
        if (action) {
          action.requestIds.push(request.id);
          if (action.created.seq>=request.dispatch.seq) issue("action-not-before-dispatch",{...identity,actionId:action.id,requestId:request.id});
          if (request.code!==3 && action.code!==request.code) issue("single-action-code-mismatch",{...identity,actionId:action.id,requestId:request.id});
        } else unresolved.push({requestId:request.id,actionId:link.actionId,missing:"action"});
      }
    }
    for (const action of logical.values()) if (action.readId) {
      const read=reads.get(action.readId);
      if (!read) unresolved.push({actionId:action.id,readId:action.readId,missing:"readBegin"});
      else {
        read.actionIds.push(action.id); read.requestIds.push(...action.requestIds);
        if (read.begin.seq>=action.created.seq) issue("read-not-before-action",{...identity,readId:read.id,actionId:action.id});
      }
    }
    for (const read of reads.values()) {
      read.requestIds=[...new Set(read.requestIds)];
      read.observedChannelIdsForKey=[...new Set(subscriptions.filter(s=>s.keyId===read.keyId).map(s=>s.channelId))];
      read.actualDispatches=read.requestIds.map(id=>requests.get(id)).map(r=>({requestId:r.id,action:r.action,proofId:r.proofId,proofBarrier:r.proofBarrier??0,...r.dispatch}));
      read.receivedProofLinks=read.receives.filter(r=>r.receivedProofBarrier!==0).map(receive=>({
        receiveSeq:receive.seq,barrier:receive.receivedProofBarrier,
        matchingReadRequestIds:read.actualDispatches.filter(d=>d.proofBarrier===receive.receivedProofBarrier && d.seq<receive.seq).map(d=>d.requestId)
      }));
      for (const receive of read.receives) if (receive.effectiveBegan!==Math.max(read.began,receive.receivedProofBarrier)) issue("received-effective-boundary-mismatch",{...identity,readId:read.id,seq:receive.seq});
      for (const received of read.receivedProofLinks) if (!received.matchingReadRequestIds.length) unresolved.push({readId:read.id,receiveSeq:received.receiveSeq,barrier:received.barrier,missing:"matching-read-dispatch-proof-chain"});
      read.completedAtCut=read.settles.length>0;
    }
    for (const decision of decisions) {
      decision.matchingPriorFlushRows=flushes.filter(f=>f.keyId===decision.keyId && f.after===decision.after && f.seq<decision.seq).map(f=>f.seq);
      decision.matchingPriorInvalidationRows=invalidations.filter(i=>i.keyId===decision.keyId && i.pendingAfter===decision.after && i.seq<decision.seq).map(i=>i.seq);
      decision.matchingPriorInvalidationCauses=[...new Set(invalidations.filter(i=>decision.matchingPriorInvalidationRows.includes(i.seq)).map(i=>i.cause))];
      const read=reads.get(decision.readId);
      if (read) {
        decision.readBegan=read.began;
        decision.readDispatchesBeforeDecision=read.actualDispatches.filter(d=>d.seq<decision.seq);
        decision.receivesBeforeDecision=read.receives.filter(r=>r.seq<decision.seq);
        decision.settlesBeforeDecision=read.settles.filter(s=>s.seq<decision.seq);
        decision.observedChannelIdsForKey=read.observedChannelIdsForKey;
      }
      if ([1,2,3].includes(decision.branch) && (decision.began>decision.after || decision.pendingDispatchAt>decision.after)) issue("revalidate-branch-boundary-mismatch",{...identity,seq:decision.seq});
      if (decision.branch===4 && !(decision.began>decision.after)) issue("wait-read-branch-boundary-mismatch",{...identity,seq:decision.seq});
      if (decision.branch===5 && !(decision.began<=decision.after && decision.pendingDispatchAt>decision.after)) issue("wait-pending-branch-boundary-mismatch",{...identity,seq:decision.seq});
      if (decision.branch===10 && !(decision.effectiveBegan>decision.after)) issue("reuse-branch-boundary-mismatch",{...identity,seq:decision.seq});
    }
    const counts = values => Object.fromEntries([...new Set(values)].sort().map(value=>[value,values.filter(v=>v===value).length]));
    report.realms.push({
      ...identity,records:aggregate.records,captureIncompleteRecords:aggregate.captureIncompleteRecords,
      uniqueRows:rows.length,firstSeq:rows[0]?.[0]??null,lastSeq:rows.at(-1)?.[0]??null,
      summary:{reads:reads.size,settledReads:[...reads.values()].filter(r=>r.completedAtCut).length,logicalActions:logical.size,physicalDispatches:requests.size,actionCounts:counts([...logical.values()].map(a=>a.action)),physicalCounts:counts([...requests.values()].map(r=>r.action)),readlessActions:[...logical.values()].filter(a=>!a.readId).map(a=>({id:a.id,action:a.action})),freshBranches:counts(decisions.map(d=>d.name)),revalidationDecisions:decisions.filter(d=>d.callsRevalidate).length,proofs:proofs.size,channelCount:channels.size,unresolvedAssociations:unresolved.length},
      reads:[...reads.values()],actions:[...logical.values()],requests:[...requests.values()],proofs:[...proofs.values()],
      channels:[...channels.values()],fresh:decisions,scopeResets,unresolvedAssociations:unresolved
    });
  }
  report.causalConsistency=report.issues.length?"issues-present":"no-detected-inconsistency";
  return report;
}
