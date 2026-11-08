#!/usr/bin/env python3
"""Owner-authorized idle Mikka runtime switch. Never edits the official image or user data."""
import contextlib,fcntl,json,os,pathlib,pwd,re,signal,socket,stat,subprocess,sys,time,uuid
RUNTIME=pathlib.Path('/opt/mikka')
HOME=pathlib.Path('/home/user/.mikka')
CONTROL=pathlib.Path('/run/mikka-review-control')
ROOT_UID=0
USER_UID=None

# Only these identifiers leave the root command. Never forward an exception,
# path, command output, credential-bearing identity, or arbitrary JSON field.
REFUSAL_CODES=frozenset(['runtime_identity_mismatch', 'runtime_install_untrusted', 'runtime_invalid_json', 'runtime_io_error', 'runtime_journal_invalid', 'runtime_journal_missing', 'runtime_journal_unreadable', 'runtime_journal_untrusted', 'runtime_native_busy', 'runtime_path_missing', 'runtime_permission_denied', 'runtime_pid_unavailable', 'runtime_pid_untrusted', 'runtime_process_mismatch', 'runtime_process_owner_mismatch', 'runtime_process_predates_switch', 'runtime_receipt_untrusted', 'runtime_refresh_conflict', 'runtime_refresh_invalid', 'runtime_refresh_refused', 'runtime_refresh_requires_host', 'runtime_rollback_mismatch', 'runtime_rollback_untrusted', 'runtime_running_pid_unavailable', 'runtime_running_process_mismatch', 'runtime_running_source_mismatch', 'runtime_source_changed', 'runtime_stage_source_mismatch', 'runtime_stage_source_unavailable', 'runtime_stage_untrusted', 'runtime_staging_conflict', 'runtime_stop_unconfirmed'])
PHASE='arguments'
def phase(value):
    global PHASE
    PHASE=value

def refusal(error):
    if isinstance(error,RuntimeError) and str(error) in REFUSAL_CODES:return str(error)
    if isinstance(error,FileNotFoundError):return 'runtime_path_missing'
    if isinstance(error,PermissionError):return 'runtime_permission_denied'
    if isinstance(error,(json.JSONDecodeError,UnicodeDecodeError)):return 'runtime_invalid_json'
    if isinstance(error,OSError):return 'runtime_io_error'
    return 'runtime_refresh_refused'

def regular(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=ROOT_UID or info.st_mode & 0o022:raise RuntimeError('runtime_receipt_untrusted')
    return path.read_text().strip()

def journal_idle(device,workspace):
    data=HOME/'worker'
    identity=json.loads((data/'device.json').read_text())
    if identity.get('deviceId')!=device or identity.get('workspaceId')!=workspace:raise RuntimeError('runtime_identity_mismatch')
    journal=data/'runs.json'
    try:info=journal.lstat()
    except FileNotFoundError:raise RuntimeError('runtime_journal_missing') from None
    if not stat.S_ISREG(info.st_mode):raise RuntimeError('runtime_journal_untrusted')
    # ENOENT is a refusal, not evidence of an idle/fresh worker. In particular,
    # a legacy worker may have lost history; never recreate its journal here.
    try:
        descriptor=os.open(journal,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(descriptor) as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):raise RuntimeError('runtime_journal_untrusted')
            value=json.load(handle)
    except FileNotFoundError:raise RuntimeError('runtime_journal_missing') from None
    except PermissionError:raise RuntimeError('runtime_journal_unreadable') from None
    except (json.JSONDecodeError,UnicodeDecodeError):raise RuntimeError('runtime_journal_invalid') from None
    except OSError:raise RuntimeError('runtime_journal_unreadable') from None
    runs=value.get('runs') if isinstance(value,dict) else None
    if not isinstance(runs,dict) or any(not isinstance(row,dict) or not isinstance(row.get('state'),str) for row in runs.values()):raise RuntimeError('runtime_journal_invalid')
    if any(row['state'] not in ['succeeded','failed','stopped','cancelled'] for row in runs.values()):raise RuntimeError('runtime_native_busy')

def stop_worker(old_target):
    pidfile=HOME/'worker/daemon.pid'
    if not pidfile.exists():
        probe=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);probe.settimeout(.5)
        try:probe.connect(str(HOME/'worker/daemon.sock'))
        except (FileNotFoundError,ConnectionRefusedError):return
        else:raise RuntimeError('runtime_pid_unavailable')
        finally:probe.close()
    if pidfile.is_symlink():raise RuntimeError('runtime_pid_untrusted')
    pid=int(pidfile.read_text().strip());proc=pathlib.Path('/proc')/str(pid)
    if not proc.exists():
        probe=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);probe.settimeout(.5)
        try:probe.connect(str(HOME/'worker/daemon.sock'))
        except (FileNotFoundError,ConnectionRefusedError):return
        else:raise RuntimeError('runtime_pid_unavailable')
        finally:probe.close()
    command=(proc/'cmdline').read_bytes().split(b'\0')
    cwd=(proc/'cwd').resolve()
    if not any(b'cloud-worker' in arg for arg in command) or cwd!=old_target/'packages/daemon':raise RuntimeError('runtime_process_mismatch')
    if proc.stat().st_uid!=(USER_UID if USER_UID is not None else pwd.getpwnam('user').pw_uid):raise RuntimeError('runtime_process_owner_mismatch')
    os.kill(pid,signal.SIGTERM)
    deadline=time.monotonic()+20
    while proc.exists():
        if time.monotonic()>=deadline:raise RuntimeError('runtime_stop_unconfirmed')
        time.sleep(.1)

def atomically_write(path,text):
    temp=path.with_name(path.name+'.next-'+uuid.uuid4().hex)
    if temp.exists() or temp.is_symlink():raise RuntimeError('runtime_staging_conflict')
    with temp.open('x') as handle:
        os.chmod(temp,0o444);handle.write(text+'\n');handle.flush();os.fsync(handle.fileno())
    os.replace(temp,path)

@contextlib.contextmanager
def execution_fence(mode):
    descriptor=None;directory=None
    try:
        if mode!='verify' and CONTROL.exists():
            directory=os.open(CONTROL,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            info=os.fstat(directory)
            if info.st_uid!=ROOT_UID or info.st_mode&0o022:raise RuntimeError('runtime_install_untrusted')
            descriptor=os.open('machine.lock',os.O_RDWR|os.O_NOFOLLOW,dir_fd=directory)
            info=os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=ROOT_UID or info.st_nlink!=1:raise RuntimeError('runtime_install_untrusted')
            try:fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise RuntimeError('runtime_native_busy') from None
        yield
    finally:
        if descriptor is not None:os.close(descriptor)
        if directory is not None:os.close(directory)

def switch(mode,device,workspace,old_sha,source,sha,operation):
    # A terminal owns the same execution inode as the native worker. Idle
    # journal state alone is insufficient while a human owns that checkout.
    with execution_fence(mode):return switch_locked(mode,device,workspace,old_sha,source,sha,operation)

def switch_locked(mode,device,workspace,old_sha,source,sha,operation):
    phase('arguments')
    if mode not in ['switch','rollback','verify'] or not all(re.fullmatch('[a-f0-9]{40}',value) for value in [old_sha,source,sha]) or not re.fullmatch('[a-f0-9-]{36}',operation):raise RuntimeError('runtime_refresh_invalid')
    phase('installation')
    link=RUNTIME/'worker';marker=RUNTIME/'worker-source-sha';backup=RUNTIME/'runtime-refresh'/operation
    if not link.is_symlink() or link.lstat().st_uid!=ROOT_UID:raise RuntimeError('runtime_install_untrusted')
    current=link.resolve();releases=(RUNTIME/'releases').resolve()
    if current.name!='source' or current.parent.parent!=releases or current.stat().st_uid!=ROOT_UID:raise RuntimeError('runtime_install_untrusted')
    if mode=='verify':
        phase('verify_process')
        identity=json.loads((HOME/'worker/device.json').read_text())
        if identity.get('deviceId')!=device or identity.get('workspaceId')!=workspace or regular(marker)!=sha or current!=RUNTIME/'releases'/source/'source':raise RuntimeError('runtime_running_source_mismatch')
        pidfile=HOME/'worker/daemon.pid'
        if pidfile.is_symlink() or not pidfile.is_file():raise RuntimeError('runtime_running_pid_unavailable')
        pid=int(pidfile.read_text().strip());proc=pathlib.Path('/proc')/str(pid)
        if not proc.exists() or (proc/'cwd').resolve()!=current/'packages/daemon' or not any(b'cloud-worker' in arg for arg in (proc/'cmdline').read_bytes().split(b'\0')):raise RuntimeError('runtime_running_process_mismatch')
        if proc.stat().st_uid!=(USER_UID if USER_UID is not None else pwd.getpwnam('user').pw_uid):raise RuntimeError('runtime_process_owner_mismatch')
        if backup.exists():
            saved=json.loads(regular(backup))
            start_tick=int((proc/'stat').read_text().rsplit(')',1)[1].split()[19])
            if saved.get('newSha')!=sha or start_tick<saved.get('switchBootTick',float('inf')):raise RuntimeError('runtime_process_predates_switch')
        print(json.dumps({'status':'verified_process','workerSourceCommit':source,'workerSha':sha,'pid':pid}));return
    phase('journal_before_stop')
    journal_idle(device,workspace)
    if mode=='switch':
        phase('stage')
        if regular(marker)!=old_sha:raise RuntimeError('runtime_source_changed')
        target=RUNTIME/'releases'/source/'source'
        if target.is_symlink() or target.resolve()!=target or regular(target.parent/'worker-ready.sha')!=sha:raise RuntimeError('runtime_stage_untrusted')
        try:actual=subprocess.check_output(['git','-c','core.hooksPath=/dev/null','-C',str(target),'rev-parse','HEAD'],text=True,stderr=subprocess.DEVNULL).strip()
        except subprocess.CalledProcessError:raise RuntimeError('runtime_stage_source_unavailable') from None
        if actual!=source:raise RuntimeError('runtime_stage_source_mismatch')
        phase('backup')
        backup.parent.mkdir(mode=0o700,exist_ok=True)
        if backup.exists():raise RuntimeError('runtime_refresh_conflict')
        # No credential or user file content enters this root-only recovery receipt.
        with backup.open('x') as handle:
            os.chmod(backup,0o600);json.dump({'oldTarget':str(current),'oldSha':old_sha,'newTarget':str(target),'newSha':sha},handle);handle.flush();os.fsync(handle.fileno())
    else:
        phase('backup')
        record=json.loads(regular(backup))
        if record['newSha']!=sha or record['oldSha']!=old_sha or regular(marker) not in [old_sha,sha]:raise RuntimeError('runtime_rollback_mismatch')
        target=pathlib.Path(record['oldTarget'])
        if target.parent.parent!=releases or target.name!='source' or target.stat().st_uid!=ROOT_UID:raise RuntimeError('runtime_rollback_untrusted')
    phase('stop_worker')
    stop_worker(current)
    phase('journal_after_stop')
    journal_idle(device,workspace)
    phase('switch_link')
    temp=RUNTIME/('worker-next-'+operation)
    if temp.exists() or temp.is_symlink():raise RuntimeError('runtime_staging_conflict')
    temp.symlink_to(target);os.replace(temp,link)
    # A new worker participates in the same fixed-inode execution fence as an
    # owner terminal. Rollback to a legacy worker must withdraw its capability.
    control_install=target/'packages/daemon/scripts/workspace-control-install.py'
    if control_install.is_file():
        subprocess.run([sys.executable,str(control_install)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    else:
        (CONTROL/'version').unlink(missing_ok=True)
    phase('switch_marker')
    atomically_write(marker,sha if mode=='switch' else old_sha)
    if mode=='switch':
        phase('switch_receipt')
        record=json.loads(regular(backup));record['switchBootTick']=int(float(pathlib.Path('/proc/uptime').read_text().split()[0])*os.sysconf('SC_CLK_TCK'));atomically_write(backup,json.dumps(record))
    print(json.dumps({'status':'switched' if mode=='switch' else 'restored_not_ready','previousWorkerSha':old_sha,'workerSourceCommit':source if mode=='switch' else target.parent.name,'workerSha':sha if mode=='switch' else old_sha}))

if __name__=='__main__':
    action=sys.argv[1] if len(sys.argv)>1 and sys.argv[1] in ['switch','rollback','verify'] else 'unknown'
    try:
        if os.geteuid()!=0:raise RuntimeError('runtime_refresh_requires_host')
        switch(*sys.argv[1:])
    except Exception as error:
        print(json.dumps({'protocol':'mikka-runtime-refresh-refusal/v1','action':action,'phase':PHASE,'code':refusal(error)}),file=sys.stderr)
        sys.exit(1)
