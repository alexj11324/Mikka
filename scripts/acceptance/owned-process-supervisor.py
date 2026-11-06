#!/usr/bin/env python3
"""Test-only Linux owner for one app and every descendant, including setsid children."""
import ctypes,json,os,pathlib,signal,subprocess,sys,time

def main():
 os.umask(0o077)
 receipt=pathlib.Path(sys.argv[1]);command=sys.argv[2:]
 if not command or not receipt.is_absolute():raise SystemExit('OWNED_SUPERVISOR_ARGUMENTS')
 fd=os.open(receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 libc=ctypes.CDLL(None,use_errno=True)
 enabled=ctypes.c_int(0)
 if libc.prctl(36,1,0,0,0)!=0 or libc.prctl(37,ctypes.byref(enabled),0,0,0)!=0 or enabled.value!=1:
  os.close(fd);raise SystemExit('OWNED_SUPERVISOR_UNAVAILABLE')
 if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):
  os.close(fd);raise SystemExit('OWNED_SUPERVISOR_PIDFD_UNAVAILABLE')
 owner=os.getpid();uid=os.getuid();stop=False;received=None;handles={};observed={};sent=set();forcedSent=set();stoppingAt=None
 report={'version':1,'scope':'process-cleanup','subreaperConfirmed':True,'supervisorPid':owner,'uid':uid,'status':'failed','forced':False}
 def request_stop(signum,_frame):
  nonlocal stop,received
  stop=True;received=signum
 signal.signal(signal.SIGTERM,request_stop);signal.signal(signal.SIGINT,request_stop)
 def table():
  rows={}
  for p in pathlib.Path('/proc').iterdir():
   if not p.name.isdigit():continue
   try:
    line=(p/'stat').read_text();a=line[line.rfind(')')+2:].split()
    rows[int(p.name)]={'pid':int(p.name),'ppid':int(a[1]),'pgid':int(a[2]),'sid':int(a[3]),'startTicks':a[19],'state':a[0]}
   except (OSError,ValueError):pass
  members={owner}
  while True:
   more={p for p,r in rows.items() if r['ppid'] in members}
   if more<=members:break
   members|=more
  return [r for p,r in rows.items() if p in members and p!=owner]
 def current(row):
  p=pathlib.Path('/proc')/str(row['pid'])
  try:
   line=(p/'stat').read_text();a=line[line.rfind(')')+2:].split()
   if a[19]!=row['startTicks'] or a[0]=='Z':return False
   s=dict(x.split(':',1) for x in (p/'status').read_text().splitlines() if ':' in x)
   if int(s['Uid'].split()[0])!=uid:raise RuntimeError('DESCENDANT_UID_CHANGED')
   return True
  except (FileNotFoundError,ProcessLookupError):return False
 child=None
 try:
  child=subprocess.Popen(command,stdin=subprocess.DEVNULL)
  report['rootPid']=child.pid
  while True:
   child.poll()
   if child.returncode is not None:stop=True
   if stop and stoppingAt is None:stoppingAt=time.monotonic()
   if stoppingAt is not None and time.monotonic()-stoppingAt>=30:report['forced']=True
   rows=table()
   for row in rows:
    key=(row['pid'],row['startTicks'])
    if key not in observed:
     observed[key]={k:v for k,v in row.items() if k!='state'}
    if row['state']=='Z' and row['ppid']==owner and row['pid']!=child.pid:
     try:os.waitpid(row['pid'],os.WNOHANG)
     except ChildProcessError:pass
     continue
    if not current(row):continue
    if key not in handles:
     try:handles[key]=os.pidfd_open(row['pid'])
     except ProcessLookupError:continue
     if not current(row):continue
    if stop and key not in sent:
     try:signal.pidfd_send_signal(handles[key],signal.SIGTERM,None,0);sent.add(key)
     except ProcessLookupError:pass
    if report['forced'] and key not in forcedSent:
     try:signal.pidfd_send_signal(handles[key],signal.SIGKILL,None,0);forcedSent.add(key)
     except ProcessLookupError:pass
   child.poll()
   if child.returncode is not None and not any(r['state']!='Z' for r in table()):
    while True:
     try:
      pid,_=os.waitpid(-1,os.WNOHANG)
      if pid==0:break
     except ChildProcessError:break
    break
   time.sleep(.05)
  report.update(status='passed',rootExitCode=child.returncode,signalReceived=received,liveRemaining=0)
 except BaseException as error:
  report['errorCode']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
 finally:
  report['forcedSignalled']=[{'pid':p,'startTicks':t} for p,t in sorted(forcedSent)]
  report['observed']=list(observed.values());report['signalled']=[{'pid':p,'startTicks':t} for p,t in sorted(sent)]
  for handle in handles.values():os.close(handle)
  os.write(fd,(json.dumps(report,indent=2)+'\n').encode());os.close(fd)
 if report['status']!='passed':raise SystemExit('OWNED_SUPERVISOR_FAILED')
 raise SystemExit(0 if child.returncode in [0,-signal.SIGTERM,-signal.SIGINT] and stop else (child.returncode or 0))

if __name__ == '__main__':
 main()
