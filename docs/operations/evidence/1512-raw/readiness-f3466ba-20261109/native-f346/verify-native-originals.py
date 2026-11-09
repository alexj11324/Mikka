import os,json,pathlib,hashlib,gzip,re,statistics,datetime,collections,base64
R=pathlib.Path(os.environ['FORENSIC_ROOT']);P=R/'public';P.mkdir(exist_ok=True)
def read(p): return json.loads((R/p).read_bytes())
L=read('native-f346-original/lifecycle.json');S=read('native-f346-original/smoke.json');Y=read('native-f346-original/parity/parity.json');C=read('package-f346-original/native-crypto.json');K=read('package-f346-original/mac-acceptance-package.json')
source=os.environ['FORENSIC_REVISION']
expected={'webLogin':['common-email-authentication','web-navigation-to-dom-content-loaded','workspace-selection-to-usable'],'nativeLogin':['common-email-authentication','native-pkce-and-automatic-renderer-to-public-session','workspace-selection-to-usable'],'startup-bundled':['launch-to-usable'],'startup-hosted':['launch-to-usable']}
fields=['queryCalls','pgProtocolReceiveBytes','pgProtocolSendBytes','closedConnections','unknownReadings'];W=L['queryCounts']['windows'];base=W['webLogin']['checkpoints'][0]['snapshot'];ops=list(base['queryOperations']);sources=list(base['unattributedSources']);assert len(ops)==17 and len(sources)==78
def nonneg(v): return isinstance(v,int) and not isinstance(v,bool) and v>=0
def buckets(v):
 for f in fields: assert nonneg(v[f]),'nonnegative'
 assert set(v['queryOperations'])==set(ops) and set(v['unattributedSources'])==set(sources),'bucketLabels'
 assert all(nonneg(x) for d in ('queryOperations','unattributedSources') for x in v[d].values()),'bucketNonnegative'
 assert sum(v['queryOperations'].values())==v['queryCalls'],'operationSum'
 assert sum(v['unattributedSources'].values())==v['queryOperations']['unattributed'],'sourceSum'
def iso(ms):return datetime.datetime.fromtimestamp(ms/1000,datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def delta(a,b,d):
 buckets(d)
 assert (a['pid'],a['runtime'],a['startedAt'])==(b['pid'],b['runtime'],b['startedAt']),'sourceStable'
 assert d['startedAt']==iso(a['endedAt']) and d['finishedAt']==iso(b['endedAt']) and d['durationMs']==b['endedAt']-a['endedAt'],'windowTimes'
 for f in fields: assert d[f]==b[f]-a[f],f
 for f in ('queryOperations','unattributedSources'):assert d[f]=={k:b[f][k]-a[f][k] for k in a[f]},'bucketDelta'
snapshots=[];summary={};records=0
for name,w in W.items():
 assert w['status']=='complete','windowStatus'
 assert [c['phase'] for c in w['checkpoints']]==['before']+expected[name],'checkpointPhases'
 assert [c['phase'] for c in w['segments']]==expected[name],'segmentPhases'
 if name.startswith('startup-'): assert w['pair']==1,'firstPair'
 ss=[c['snapshot'] for c in w['checkpoints']]
 for s in ss:buckets(s);snapshots.append(s);records+=1
 for i,d in enumerate(w['segments']):delta(ss[i],ss[i+1],d);records+=1
 delta(ss[0],ss[-1],w['total']);records+=1
 for f in fields:assert w['total'][f]==sum(d[f] for d in w['segments']),'segmentTotal'
 for f in ('queryOperations','unattributedSources'):
  for k in w['total'][f]:assert w['total'][f][k]==sum(d[f][k] for d in w['segments']),'segmentBucketTotal'
 summary[name]={'queryCalls':w['total']['queryCalls'],'checkpoints':[{'phase':c['phase'],'queryCalls':c['snapshot']['queryCalls'],'endedAt':c['snapshot']['endedAt']} for c in w['checkpoints']],'segments':[{'phase':d['phase'],**{f:d[f] for f in fields}} for d in w['segments']],'startedAt':w['total']['startedAt'],'finishedAt':w['total']['finishedAt'],'operations':w['total']['queryOperations'],'sources':w['total']['unattributedSources']}
assert records==24 and len(snapshots)==12
assert len({(s['pid'],s['startedAt'],s['runtime']) for s in snapshots})==1
ordered=sorted(snapshots,key=lambda s:s['endedAt'])
for a,b in zip(ordered,ordered[1:]):
 for f in fields:assert b[f]>=a[f],'globalMonotonic'
 for f in ('queryOperations','unattributedSources'):assert all(b[f][k]>=a[f][k] for k in a[f]),'globalBucketMonotonic'
assert L['queryCounts']['login']['comparable'] is True
assert all(x==source for x in [L['revision'],S['revision'],Y['appRevision'],Y['harnessRevision'],C['revision'],L['queryCounts']['source']['revision']]),'revisions'
assert all(v['revision']==source for v in L['renderers'].values()),'rendererRevision'
assert L['queryCounts']['source']['platform']=='darwin' and L['queryCounts']['source']['arch']=='arm64'
for x in [L,S,Y]:assert x['result']=='passed','functionalityResult'
assert len(Y['screens'])==len(Y['requiredScreens'])*len(Y['themes']) and all(x['passed'] for x in Y['screens']) and Y['pageErrors']==[]
assert all(x['ready'] and x['environment']['available'] and x['environment']['profileMatches'] and x['environment']['overrideMatches'] for x in L['nativeSetup'])
for x in [L,S]:assert all(c['result']=='passed' for c in x['checks']),'checks'
assert C['passed'] and C['sameImmutablePackage'] and C['distinctProcesses']==3 and len(C['launches'])==3
assert all(x['passed'] and x['crypto']['passed'] and x['processExited'] for x in C['launches'])
assert C['cleanup']=='passed' and K['passed'] and K['signatureVerifiedStrictDeep'] and C['package']==K
pairs=L['coldStart']['pairs'];assert pairs>=5 and len(L['samples'])==pairs*2
for i in range(1,pairs+1):
 samples=[s for s in L['samples'] if s['pair']==i];assert [s['order'] for s in samples]==[1,2]
 assert [s['mode'] for s in samples]==(['bundled','hosted'] if i%2 else ['hosted','bundled'])
for mode in ['bundled','hosted']:assert statistics.median(s['milliseconds'] for s in L['samples'] if s['mode']==mode)==L['coldStart'][mode+'MedianMs']
cleanup={}
for name,x in [('lifecycle',L),('smoke',S)]:
 assert all(s['result']=='passed' for s in x['cleanupStages'])
 assert x['nativeCleanup']['cleaned'] and x['accountObservation']['observed'] and x['accountObservation']['state']=='released'
 obs=x['accountObservation'];workspace=x['workspaceNameCleanup']
 assert workspace['ownerMatchesSealedBaseline'] and workspace['peerMatchesSealedBaseline']
 for role in ['owner','peer']:
  assert isinstance(obs[role]['matchesSealedBaselineBefore'],bool) and obs[role]['matchesSealedBaselineAfter'] is True
 cleanup[name]={'stages':x['cleanupStages'],'native':x['nativeCleanup'],'observation':{role:{k:obs[role][k] for k in ['matchesSealedBaselineBefore','matchesSealedBaselineAfter','changedTableCount']} for role in ['owner','peer']},'state':obs['state'],'workspaceNameRestored':workspace.get('restored'),'workspaceOwnerBaselineAfter':workspace['ownerMatchesSealedBaseline'],'workspacePeerBaselineAfter':workspace['peerMatchesSealedBaseline']}
assert Y['cleanup']=='passed' and Y['nativeCleanup']['cleaned']
assert Y['workspaceNameCleanup']['ownerMatchesSealedBaseline'] and Y['workspaceNameCleanup']['peerMatchesSealedBaseline']
cleanup['parity']={'cleanup':Y['cleanup'],'native':Y['nativeCleanup'],'workspaceNameRestored':Y['workspaceNameCleanup'].get('restored'),'workspaceOwnerBaselineAfter':True,'workspacePeerBaselineAfter':True}
rpc=L['queryCounts']['rpcActions']; rpc_summary={}
metrics=['startedInWindow','completedInWindow','crossesStart','crossesEnd','completionNotObserved','completionWithoutStart']
def actions(a):
 for x in a:
  assert all(nonneg(x[k]) for k in metrics)
  assert x['completionNotObserved']==x['completionWithoutStart']==0
  assert x['startedInWindow']+x['crossesStart']==x['completedInWindow']+x['crossesEnd']
  assert all(100<=s['status']<=599 and nonneg(s['count']) for s in x['statusCounts'])
  assert sum(s['count'] for s in x['statusCounts'])==x['completedInWindow']+x['crossesEnd']
for name,rr in [('physical',rpc),('logical',rpc['logical'])]:
 assert rr['status']=='complete' and rr['reasons']==[] and rr['duplicateRecords']==rr['conflictingInvocations']==0
 rpc_summary[name]={}
 for wn,rw in rr['windows'].items():
  w=W[wn];assert rw['status']==rw['segmentStatus']=='complete'
  assert rw['startedAt']==w['total']['startedAt'] and rw['finishedAt']==w['total']['finishedAt']
  assert [s['phase'] for s in rw['segments']]==expected[wn];actions(rw['actions'])
  for a,b in zip(rw['segments'],w['segments']):
   assert a['startedAt']==b['startedAt'] and a['finishedAt']==b['finishedAt'];actions(a['actions'])
  for key in ['startedInWindow','completedInWindow']:
   counter=collections.Counter()
   for seg in rw['segments']:
    for a in seg['actions']:counter[(a['route'],a['rpcAction'])]+=a[key]
   for a in rw['actions']:assert counter[(a['route'],a['rpcAction'])]==a[key]
  rpc_summary[name][wn]={'started':sum(a['startedInWindow'] for a in rw['actions']),'completed':sum(a['completedInWindow'] for a in rw['actions']),'actions':rw['actions']}
D=rpc['queryDiagnostics'];assert D['columns']==['queryCalls','context','statement','scope'] and D['version']==1
assert D['scopeKeys']==list(dict.fromkeys(ops+sources))
assert D['contexts'][0]==D['statements'][0]=={'status':'unknown'}
assert 1<=len(D['contexts'])<=2048 and 1<=len(D['statements'])<=512
uuid=re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
methods={'GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'}
closed_actions={'desktop.session','desktop.bootstrap','desktop.readBatch','workspace.switchWorkspace','execution-settings.getBotModelMenu','preferences.getPreferences','agents.listDevices','bots.pollBots','issues.syncIssueList','projects.listProjects','teams.listTeams','team-relations.listProjectTeams','task-runs.pollTaskRuns','task-runs.syncThreadList','coordinator.pollBotChatSummaries','coordinator.syncCoordinatorChat'}
routes={x for x in ops+sources if x.startswith(('/api/','/v1/'))}
for c in D['contexts'][1:]:
 assert set(c)=={'status','httpInvocationId','invocationId','route','method','rpcAction'} and c['status']=='known'
 assert uuid.fullmatch(c['httpInvocationId']) and uuid.fullmatch(c['invocationId'])
 assert c['route'] in routes and c['method'] in methods and (c['rpcAction'] is None or c['rpcAction'] in closed_actions)
 if c['invocationId']!=c['httpInvocationId']:assert c['rpcAction'] is not None
for s in D['statements'][1:]:
 assert set(s)=={'status','normalizedStructureId','command','parameterCount'} and s['status']=='known'
 assert re.fullmatch('[0-9a-f]{12}',s['normalizedStructureId']) and s['command'] in {'SELECT','WITH','INSERT','UPDATE','DELETE','BEGIN','COMMIT','ROLLBACK'}
 assert nonneg(s['parameterCount']) and s['parameterCount']<=65535
cap=D['capture'];assert all(nonneg(cap[k]) for k in ['fromQueryCalls','toQueryCalls','droppedQueries']) and cap['toQueryCalls']>=cap['fromQueryCalls']
assert cap['overflow']==bool(cap['droppedQueries'] or cap['reasons'].get('context_limit') or cap['reasons'].get('statement_limit'))
receipts=D['receipts'];assert receipts['status']=='complete' and receipts['reasons']==[]
assert all(receipts[k]==0 for k in ['unmatchedQueryContexts','unpairedInvocations','conflictingInvocations'])
invs=receipts['invocations'];assert len(invs)<=4096;ir={x['invocationId']:x for x in invs};assert len(ir)==len(invs)
for c in invs:
 assert c['status']=='known' and uuid.fullmatch(c['httpInvocationId']) and uuid.fullmatch(c['invocationId'])
 assert c['route'] in routes and c['method'] in methods and (c['rpcAction'] is None or c['rpcAction'] in closed_actions)
 assert c['startedAt']<=c['completedAt'] and 100<=c['httpStatus']<=599 and not c.get('conflict',False)
 if c['invocationId']!=c['httpInvocationId']:
  parent=ir[c['httpInvocationId']];assert parent['rpcAction']=='desktop.readBatch' and parent['route']==c['route'] and parent['method']==c['method']
  assert parent['startedAt']<=c['startedAt']<=c['completedAt']<=parent['completedAt']
for c in invs:
 if 'rpcItemCount' in c:assert c['rpcItemCount']==sum(x['httpInvocationId']==c['invocationId'] and x['invocationId']!=c['invocationId'] for x in invs)
diag_summary={};allord=set()
for wn,d in D['windows'].items():
 w=W[wn];start=w['checkpoints'][0]['snapshot']['queryCalls'];end=w['checkpoints'][-1]['snapshot']['queryCalls'];rows=d['queries']
 assert d['fromQueryCalls']==start and d['toQueryCalls']==end and cap['fromQueryCalls']<=start<=end<=cap['toQueryCalls']
 assert d['expectedQueries']==d['capturedQueries']==len(rows)==w['total']['queryCalls'] and d['uncapturedQueries']==0
 assert [x[0] for x in rows]==list(range(start+1,end+1))
 oo=dict.fromkeys(ops,0);ss=dict.fromkeys(sources,0);uc=us=0;usc=collections.Counter();ucc=collections.Counter()
 for row in rows:
  assert len(row)==4 and all(nonneg(x) for x in row)
  n,ci,si,scope=row;assert n not in allord;allord.add(n)
  assert ci<len(D['contexts']) and si<len(D['statements']) and scope<len(D['scopeKeys'])
  label=D['scopeKeys'][scope];assert label!='unattributed'
  if label in oo:oo[label]+=1
  else:ss[label]+=1;oo['unattributed']+=1
  if ci==0:uc+=1;ucc[label]+=1
  else:
   c=D['contexts'][ci];r=ir[c['invocationId']]
   assert all(c[k]==r[k] for k in ['httpInvocationId','invocationId','route','method'])
   if c['rpcAction'] is not None:assert c['rpcAction']==r['rpcAction']
  if si==0:us+=1;usc[label]+=1
 assert oo==w['total']['queryOperations'] and ss==w['total']['unattributedSources']
 assert d['unknownContextQueries']==uc and d['unknownStatementQueries']==us
 for seg,orig,a,b in zip(d['segments'],w['segments'],w['checkpoints'],w['checkpoints'][1:]):
  assert seg=={'phase':orig['phase'],'fromQueryCalls':a['snapshot']['queryCalls'],'toQueryCalls':b['snapshot']['queryCalls']}
  assert sum(seg['fromQueryCalls']<x[0]<=seg['toQueryCalls'] for x in rows)==orig['queryCalls']
 assert d['status']==('incomplete' if uc or us or d['uncapturedQueries'] or cap['overflow'] else 'complete')
 diag_summary[wn]={'status':d['status'],'reasons':d['reasons'],'queries':len(rows),'unknownContext':uc,'unknownStatement':us,'unknownContextByScope':dict(ucc),'unknownStatementByScope':dict(usc)}
arith={'version':1,'actualRevision':source,'actualTree':os.environ['FORENSIC_TREE'],'sourceBasis':'Native own job checkout log plus same-SHA exact commit API','headRevision':os.environ['FORENSIC_HEAD_REVISION'],'headTree':os.environ['FORENSIC_HEAD_TREE'],'records':records,'checkpoints':len(snapshots),'operationBuckets':len(ops),'sourceBuckets':len(sources),'unknownReadingsByWindow':{k:w['total']['unknownReadings'] for k,w in W.items()},'windows':summary,'originalContracts':{k:L['queryCounts'][k] for k in ['scope','exclusions','background','boundary','login','startup']},'measurement':L['measurement'],'fullLoginBudgetPassed':W['nativeLogin']['total']['queryCalls']<=W['webLogin']['total']['queryCalls'],'firstPairBudgetPassed':W['startup-bundled']['total']['queryCalls']<=W['startup-hosted']['total']['queryCalls'],'unchangedOriginalBoundaries':True,'excludedBackgroundQueries':0,'externalProductionAcceptance':False}
(P/'arithmetic.safe.json').write_text(json.dumps(arith,indent=2)+'\n')
(P/'rpc-diagnostics.safe.json').write_text(json.dumps({'rpc':rpc_summary,'diagnostics':{'status':D['status'],'capture':cap,'receiptStatus':receipts['status'],'receiptCount':len(invs),'contexts':len(D['contexts']),'statements':len(D['statements']),'windows':diag_summary,'totalProjectedQueries':len(allord),'strictOrdinalAndScopeConservation':True,'unknownsRetained':True,'noSqlTextOrValues':True}},indent=2)+'\n')
(P/'cleanup-package.safe.json').write_text(json.dumps({'revision':source,'cleanup':cleanup,'crypto':{'passed':C['passed'],'distinctProcesses':C['distinctProcesses'],'sameImmutablePackage':C['sameImmutablePackage'],'cleanup':C['cleanup']},'package':K,'checks':{'lifecycle':len(L['checks']),'smoke':len(S['checks'])},'coldStart':L['coldStart'],'nativeSetup':L['nativeSetup'],'productionAcceptance':False},indent=2)+'\n')
print(json.dumps({'verified':True,'totals':{k:w['total']['queryCalls'] for k,w in W.items()},'records':records,'checkpoints':12,'buckets':[17,78],'diagnosticsStatus':D['status'],'projectedQueries':len(allord),'overflow':cap['overflow'],'unknowns':{k:{'context':v['unknownContext'],'statement':v['unknownStatement']} for k,v in diag_summary.items()},'cleanupAfter':{k:{r:v['observation'][r]['matchesSealedBaselineAfter'] for r in ['owner','peer']} for k,v in cleanup.items() if 'observation'in v},'nativeFiles':len(read('original-files-manifest.safe.json')[0]['files'])}))
