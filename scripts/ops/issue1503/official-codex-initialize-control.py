import argparse,importlib.metadata,json,os,re
from pathlib import Path
SDK_VERSION='2.62.0'
APPLICATION='mikka-issue1503-codex-initialize-control'
MAX_INSTANCES=1
REMOTE_PROGRAM = 'import hashlib,json,os,pathlib,re,selectors,shutil,signal,subprocess,threading,time\nfrom http.server import BaseHTTPRequestHandler,ThreadingHTTPServer\n\ndef safe_message(value):\n    text=str(value)[:2048]\n    text=re.sub(r\'(?:Bearer|Basic)\\s+\\S+\',\'[AUTH]\',text,flags=re.I)\n    text=re.sub(r\'https?://\\S+\',\'[URL]\',text)\n    text=re.sub(r\'[A-Za-z0-9_=-]{24,}\',\'[TOKEN-LIKE]\',text)\n    text=re.sub(r\'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\',\'[EMAIL]\',text)\n    return text.encode(\'utf-8\')[:2048].decode(\'utf-8\',errors=\'ignore\')\n\nclass Receiver(BaseHTTPRequestHandler):\n    def do_POST(self):\n        size=int(self.headers.get(\'content-length\',\'0\'))\n        if size>1048576:\n            self.send_response(413);self.end_headers();return\n        self.rfile.read(size)\n        self.send_response(200);self.send_header(\'Content-Type\',\'application/json\');self.end_headers();self.wfile.write(b\'{}\')\n    def log_message(self,*args): pass\n\nserver=ThreadingHTTPServer((\'127.0.0.1\',0),Receiver)\nthreading.Thread(target=server.serve_forever,daemon=True).start()\nendpoint=\'http://127.0.0.1:\'+str(server.server_port)+\'/v1/logs/issue1503-control\'\ntiming_args=[\'-c\',\'otel.exporter={otlp-http={endpoint=\'+json.dumps(endpoint)+\',protocol="json",headers={}}}\',\n \'-c\',\'otel.trace_exporter="none"\',\'-c\',\'otel.metrics_exporter="none"\',\'-c\',\'otel.log_user_prompt=false\',\n \'-c\',\'otel.log_agent_responses=false\',\'-c\',\'otel.log_guardian_assessments=false\']\ntiming_env={\'OTEL_METRICS_EXPORTER\':\'none\',\'OTEL_TRACES_EXPORTER\':\'none\',\'OTEL_LOGS_EXPORTER\':\'otlp\',\n \'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL\':\'http/json\',\'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT\':endpoint,\n \'OTEL_EXPORTER_OTLP_LOGS_HEADERS\':\'\',\'OTEL_EXPORTER_OTLP_HEADERS\':\'\',\n \'OTEL_LOGS_EXPORT_INTERVAL\':\'1000\',\'OTEL_BLRP_SCHEDULE_DELAY\':\'1000\',\'OTEL_LOG_USER_PROMPTS\':\'0\',\n \'OTEL_LOG_ASSISTANT_RESPONSES\':\'0\',\'OTEL_LOG_TOOL_DETAILS\':\'0\',\'OTEL_LOG_TOOL_CONTENT\':\'0\',\'OTEL_LOG_RAW_API_BODIES\':\'0\'}\nbinary=pathlib.Path(shutil.which(\'codex\') or \'/usr/local/bin/codex\').resolve(strict=True)\nbefore=hashlib.sha256(binary.read_bytes()).hexdigest()\nif before!=\'e14fc83739c13c1074b12bd1acce4010c893c7f6fbfc1593b4a31d74cabb57af\':raise RuntimeError(\'control_cli_entry_changed\')\nversion=subprocess.run([str(binary),\'--version\'],capture_output=True,timeout=10,check=True).stdout.decode().strip()\nif version!=\'codex-cli 0.166.0\':raise RuntimeError(\'control_cli_version_changed\')\n\ndef exchange(label,extra_args,extra_env):\n    began=time.monotonic(); stdout=b\'\'; stderr=b\'\'; response=None; termination=None\n    child=subprocess.Popen([str(binary),\'app-server\']+extra_args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,\n        cwd=\'/home/user\',env={**os.environ,**extra_env},start_new_session=True)\n    selector=selectors.DefaultSelector()\n    selector.register(child.stdout,selectors.EVENT_READ,\'stdout\');selector.register(child.stderr,selectors.EVENT_READ,\'stderr\')\n    message={\'id\':1,\'method\':\'initialize\',\'params\':{\'clientInfo\':{\'name\':\'mikka\',\'title\':\'Mikka\',\'version\':\'0.0.1\'},\'capabilities\':{\'experimentalApi\':True}}}\n    try:\n        child.stdin.write((json.dumps(message)+\'\\n\').encode());child.stdin.flush()\n        deadline=time.monotonic()+8\n        while time.monotonic()<deadline and response is None and selector.get_map():\n            for key,_ in selector.select(max(0,deadline-time.monotonic())):\n                data=os.read(key.fileobj.fileno(),4096)\n                if not data:selector.unregister(key.fileobj);continue\n                if key.data==\'stdout\':\n                    stdout+=data\n                    for line in stdout.splitlines():\n                        try: item=json.loads(line)\n                        except Exception: continue\n                        if isinstance(item,dict) and item.get(\'id\')==1:response=item;break\n                else:stderr+=data\n                if len(stdout)>65536 or len(stderr)>65536:raise RuntimeError(\'output_bound_exceeded\')\n        if response is not None and isinstance(response.get(\'result\'),dict):\n            child.stdin.write(b\'{"method":"initialized"}\\n\');child.stdin.flush()\n        code_before_stop=child.poll()\n    finally:\n        try:os.killpg(child.pid,signal.SIGTERM)\n        except ProcessLookupError:pass\n        try:child.wait(timeout=2);termination=\'sigterm_or_prior_exit\'\n        except subprocess.TimeoutExpired:\n            os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=2);termination=\'sigkill\'\n        try:\n            remaining_out,remaining_err=child.communicate(timeout=2)\n            stderr+=remaining_err or b\'\'\n        except Exception: pass\n        selector.close()\n    error=response.get(\'error\') if isinstance(response,dict) else None\n    return {\'label\':label,\'initialized\':isinstance(response,dict) and isinstance(response.get(\'result\'),dict),\n      \'rpcErrorCode\':error.get(\'code\') if isinstance(error,dict) and isinstance(error.get(\'code\'),int) else None,\n      \'rpcErrorRedacted\':safe_message(error.get(\'message\',\'\')) if isinstance(error,dict) else None,\n      \'stderrRedacted\':safe_message(stderr.decode(errors=\'replace\')),\'stderrSha256\':hashlib.sha256(stderr).hexdigest(),\n      \'stdoutBytes\':len(stdout),\'stderrBytes\':len(stderr),\'exitCodeBeforeStop\':code_before_stop,\'finalExitCode\':child.returncode,\n      \'childProcessExited\':child.returncode is not None,\'termination\':termination,\'durationMs\':round((time.monotonic()-began)*1000,3)}\ntry:\n    cases=[exchange(\'ordinary_machine_initialize\',[],{}),exchange(\'ordinary_machine_initialize_with_corrected_timing\',timing_args,timing_env)]\n    print(json.dumps({\'version\':1,\'purpose\':\'anonymous_initialize_only\',\'uid\':os.getuid(),\'cliVersion\':version,\n      \'binaryPath\':str(binary),\'binarySha256\':before,\'binaryUnchanged\':before==hashlib.sha256(binary.read_bytes()).hexdigest(),\n      \'normalHomeUsed\':os.environ.get(\'HOME\')==\'/home/user\',\'noAccountLogin\':True,\'noThreadOrTurn\':True,\'noTaskCredentialsSupplied\':True,\n      \'cases\':cases},separators=(\',\',\':\')))\nfinally:server.shutdown();server.server_close()\n'

class DiagnosticError(Exception):
    pass

def identity(environ=os.environ):
    if (environ.get('GITHUB_REPOSITORY') != 'alexj11324/Mikka'
            or not re.fullmatch(r'[a-f0-9]{40}', environ.get('GITHUB_SHA', ''))
            or not re.fullmatch(r'[1-9][0-9]*', environ.get('GITHUB_RUN_ID', ''))
            or not re.fullmatch(r'[1-9][0-9]*', environ.get('GITHUB_RUN_ATTEMPT', ''))):
        raise DiagnosticError('workflow_identity_invalid')
    return {'application': APPLICATION, 'sourceCommit': environ['GITHUB_SHA'],
            'runId': environ['GITHUB_RUN_ID'], 'runAttempt': environ['GITHUB_RUN_ATTEMPT']}

def safe_error(error):
    code = error.args[0] if isinstance(error, DiagnosticError) and error.args else None
    return {'type': type(error).__name__, **({'code': code} if isinstance(code, str) and re.fullmatch(r'[a-z_]{1,80}', code) else {})}

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)

def clean_id(Sandbox, NotFoundException, sandbox_id, key):
    receipt = {'sandboxId': sandbox_id, 'kill': 'not_attempted', 'exactIdAbsent': False}
    try:
        receipt['kill'] = 'killed' if Sandbox.kill(sandbox_id, api_key=key, request_timeout=30) else 'already_absent'
    except Exception as error:
        receipt['kill'] = 'failed'
        receipt['killError'] = safe_error(error)
    try:
        Sandbox.get_info(sandbox_id, api_key=key, request_timeout=30)
        receipt['readback'] = 'still_present'
    except NotFoundException:
        receipt['readback'] = 'not_found'
        receipt['exactIdAbsent'] = True
    except Exception as error:
        receipt['readback'] = 'failed'
        receipt['readbackError'] = safe_error(error)
    return receipt

def public_identity(info, sandbox_id):
    def identifier(value):
        return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9._+-]{1,160}', value) else None
    if info.sandbox_id != sandbox_id or identifier(info.template_id) is None:
        raise DiagnosticError('sandbox_identity_mismatch')
    # SDK 2.62 may omit build/base IDs. Explicit null never claims a pinned base.
    return {'templateId':info.template_id,'envdVersion':identifier(getattr(info,'envd_version',None)),
            'buildId':identifier(getattr(info,'build_id',None)),
            'baseTemplateId':identifier(getattr(info,'base_template_id',None)),
            'templateVersion':identifier(getattr(info,'template_version',None))}

def cleanup_owned(Sandbox, SandboxQuery, SandboxState, NotFoundException, key, own, path):
    receipt = {'version':1, 'identity':own, 'sandboxes':[], 'remaining':[], 'errors':[]}
    try:
        paginator = Sandbox.list(query=SandboxQuery(metadata=own, state=[SandboxState.RUNNING,SandboxState.PAUSED]), api_key=key, request_timeout=30)
        found=[]
        while paginator.has_next:
            found.extend(paginator.next_items())
        if len(found)>MAX_INSTANCES:
            raise DiagnosticError('cleanup_resource_bound_exceeded')
        for row in found:
            if any((row.metadata or {}).get(k)!=v for k,v in own.items()) or (row.metadata or {}).get('observation') not in {'1'}:
                raise DiagnosticError('cleanup_scope_invalid')
        for row in found:
            receipt['sandboxes'].append(clean_id(Sandbox,NotFoundException,row.sandbox_id,key))
        receipt['remaining']=[row['sandboxId'] for row in receipt['sandboxes'] if row['exactIdAbsent'] is not True]
    except Exception as error:
        receipt['errors'].append(safe_error(error))
    finally:
        save(path,receipt)
    if receipt['errors'] or receipt['remaining']:
        raise DiagnosticError('cleanup_incomplete')
    return receipt
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--cleanup-only',action='store_true');args=parser.parse_args()
    if importlib.metadata.version('e2b')!=SDK_VERSION:raise DiagnosticError('sdk_version_mismatch')
    own=identity();key=os.environ['E2B_API_KEY']
    from e2b import Sandbox,SandboxQuery,SandboxState
    from e2b.exceptions import NotFoundException
    if args.cleanup_only:
        receipt=cleanup_owned(Sandbox,SandboxQuery,SandboxState,NotFoundException,key,own,args.output)
        print(json.dumps({'event':'issue1503_initialize_cleanup','remaining':len(receipt['remaining']),'errors':len(receipt['errors'])}));return
    report={'version':1,'identity':own,'failedSource':'cad613ef0a2c553a94aaf72d44d609c93a603a1b','failedRun':'42336625140','templateRequested':'u1yrkaokyjzef8qchho5','templateAliasEvidence':'codex resolved in control42339907428','baselineControlRun':'42339907428','onlyTimingChange':'omit unsupported compression none','maxInstances':1,'instanceTimeoutSeconds':120,'status':'running','cleanupComplete':False}
    save(args.output,report)
    sandbox=None
    try:
        sandbox=Sandbox.create('u1yrkaokyjzef8qchho5',api_key=key,timeout=120,request_timeout=45,metadata={**own,'observation':'1'})
        report['sandboxId']=sandbox.sandbox_id;save(args.output,report)
        info=Sandbox.get_info(sandbox.sandbox_id,api_key=key,request_timeout=30)
        if any((info.metadata or {}).get(k)!=v for k,v in {**own,'observation':'1'}.items()):raise DiagnosticError('sandbox_identity_mismatch')
        report.update(public_identity(info,sandbox.sandbox_id))
        if report['templateId']!='u1yrkaokyjzef8qchho5':raise DiagnosticError('control_template_changed')
        result=sandbox.commands.run("python3 -B - <<'MIKKA_INITIALIZE_CONTROL'\n"+REMOTE_PROGRAM+"\nMIKKA_INITIALIZE_CONTROL",user='user',timeout=40,request_timeout=50)
        if result.exit_code!=0 or len(result.stdout.encode())>16384:raise DiagnosticError('control_command_failed')
        value=json.loads(result.stdout)
        if value.get('uid')==0 or not value.get('binaryUnchanged') or not value.get('normalHomeUsed') or len(value.get('cases',[]))!=2:raise DiagnosticError('control_receipt_invalid')
        report['observation']=value;report['status']='observed'
        report['conclusionLimit']='Current official alias only. No model/account/task execution, no derived candidate publication or acceptance claim.'
    except Exception as error:
        report['status']='failed';report['error']=safe_error(error);raise
    finally:
        if sandbox is not None:
            report['cleanup']=clean_id(Sandbox,NotFoundException,sandbox.sandbox_id,key)
            report['cleanupComplete']=report['cleanup']['exactIdAbsent'] is True
        save(args.output,report)
    if not report['cleanupComplete']:raise DiagnosticError('cleanup_incomplete')
    print(json.dumps({'event':'issue1503_initialize_control','status':report['status'],'cleanupComplete':report['cleanupComplete']}))
if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'event':'issue1503_initialize_control_failed',**safe_error(error)}));raise SystemExit(1)
