from pathlib import Path
import sys,json,re,subprocess
base=Path(sys.argv[1]);qa=base/'run/case'
def known(value):
 patterns={'file_access':'EACCES|permission denied|operation not permitted','network':'ECONNREFUSED|Connection refused|network is unreachable|EHOSTUNREACH|ENETUNREACH','enospc':'ENOSPC|no space left','not_found':'ENOENT|No such file or directory','tls':'CERT_|self.signed|certificate','loopback':'127[.]0[.]0[.]1|localhost','stream_disconnected':'responseStreamDisconnected|stream disconnected|stream closed|stream ended|before response.completed|before turn completed','timed_out':'ETIME|timed out|timeout','rate_limit':'rateLimitExceeded|rate limit','token_rejected':'unauthorized|HTTP 401|status 401','forbidden':'forbidden|HTTP 403|status 403','stale_turn':'activeTurnNotSteerable|turn not found|no active turn','format_error':'bad request|invalid json|invalid event|parse error|malformed','codex':'codex','decompress':'decompress|compress','sandbox':'sandbox|bwrap','session':'session','model':'model','provider':'provider','cli_exit':'cli_exited_early|signal [A-Z]+|app-server exited','needs_end':'response.completed','transport':'transport|httpConnectionFailed','model_5xx':'internal server error|status 50[0-9]|HTTP 50[0-9]','no_auth':'missing bearer|no api key|no credentials','websocket':'websocket','retrying':'retry|reconnect','busy':'already running|busy|simultaneous|concurrent','thread_context':'threadRollbackFailed|contextWindowExceeded','ERR_ABORTED':'AbortError|aborted|abort signal','write_file':'appendFile|writeFile|open.*jsonl','insufficient_credits':'credits','quota':'quota|rate limit','tool':'tool call|tool invocation','validation':'AssertionError|failed assertion|invalid input','completion':'completion','unix_socket':'daemon[.]sock|socketPath','evicted':'out of memory|killed','other_bad_gateway':'Bad Gateway|service unavailable|upstream','identity':'workspace|organization|user id','epoch':'stale.*epoch'}
 return [k for k,v in patterns.items() if re.search(v,str(value),re.I)]
def read(file):
 try:return Path(file).read_text()
 except OSError:return ''
def asWorker(user,path):
 # Execute only the hardcoded reader as the file's own UID. Only fixed fields
 # and classifications leave this process; never publish original model logs.
 p=subprocess.run(['sudo','-n','-u',user,'--','cat',str(path)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 return p.stdout.decode(errors='replace') if p.returncode==0 else ''
def lines(raw):
 out=[]
 for l in raw.splitlines():
  try:out.append(json.loads(l))
  except ValueError:pass
 return out
report=json.loads(read(qa/'proof.json') or '{}')
def safeid(v):return v if isinstance(v,str) and re.fullmatch(r'[0-9a-f-]{36}',v) else None
j=json.loads(asWorker('mikka-e-device',base/'device/runs.json') or '{}').get('runs',{})
allowedStatus={'starting','running','succeeded','stopped','failed','cancelled','error','device_lost','submitted','turn_ended','cancelled','unknown'}
entries=[{'state':e.get('state') if e.get('state') in allowedStatus else None,'reason':e.get('stopReason') if e.get('stopReason') in allowedStatus else None,'markers':known(e.get('error','')),'errorBytes':len(e.get('error') or ''),'seq':e.get('lastSeq')} for e in j.values()]
counts={}
for f in ['requests','results','first-token','provider-ends','decisions','claude-results']:
 rows=lines(asWorker('mikka-e-model',base/'model-state'/f'{f}.jsonl'));counts[f]={'count':len(rows),'entries':[{k:v for k,v in r.items() if k in ('aborted','textBytes','outputTokens','inputTokens','accepted','at','stream') and isinstance(v,(int,bool,str))} for r in rows[:15]],'markers':[known(r.get('error','')) for r in rows[:15]]}
daemonWarnings=[{'markers':known(str(m.get('msg',''))+' '+str(m.get('err',''))), 'level':m.get('level')} for m in lines(asWorker('mikka-e-device',base/'device/logs/daemon.log')) if isinstance(m.get('level'),int) and m['level']>=40][-12:]
print(json.dumps({'scope':'public isolated owner HTTPS, real Codex first-case only','revision':report.get('revision'),'environment':'PostgreSQL 17, original Ubuntu isolated service UIDs, official CLI and CPU GGUF','success':report.get('success',False),'checks':[{'phase':p.get('phase'),'at':p.get('at'),'mode':p.get('mode')} for p in report.get('checks',[])],'diagnostic':report.get('diagnostic',{}),'journal':entries,'model':counts,'daemonWarnings':daemonWarnings,'modelLog':known(read(qa/'codex-model.log')),'relayLog':known(read(qa/'relay.log')),'appLog':known(read(qa/'app.log')),'buildStage':read(base/'stage').strip(),'compileMarkers':known(read(base/'build.log'))}, indent=2))
