import { spawn } from 'node:child_process'
import { buildChildEnv } from '../env'
import { CodedError } from '@mikka/protocol/coded-error'

export const CLOUD_WORKSPACE_CONTROL_ROOT = '/run/mikka-review-control'

/** flock is held by a tiny child for the whole run, not per native command.
 * EOF/crash leaves an active receipt: acquiring an orphaned lock alone never
 * grants a shell. Only a confirmed native exit plus drained supervisor writes
 * produces idle. Fixed inodes live in a root-owned directory. */
const HOLD = String.raw`
import fcntl,json,os,stat,sys
root,run,device=sys.argv[1:]
d=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
info=os.fstat(d)
if info.st_uid!=0 or info.st_mode&0o022:raise SystemExit(1)
v=os.open('version',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=d)
try:
 i=os.fstat(v)
 if i.st_uid!=0 or i.st_mode&0o022 or os.read(v,16)!=b'1\n':raise SystemExit(1)
finally:os.close(v)
l=os.open('machine.lock',os.O_RDWR|os.O_NOFOLLOW,dir_fd=d)
s=os.open('machine.json',os.O_RDWR|os.O_NOFOLLOW,dir_fd=d)
for fd in (l,s):
 i=os.fstat(fd)
 if not stat.S_ISREG(i.st_mode) or i.st_uid!=0 or i.st_nlink!=1:raise SystemExit(1)
fcntl.flock(l,fcntl.LOCK_EX)
receipt={'version':1,'runId':run,'deviceId':device,'phase':'active','worktreePath':None,'nativeExited':False}
def save():
 data=json.dumps(receipt,separators=(',',':')).encode()
 os.ftruncate(s,0);os.lseek(s,0,0);os.write(s,data);os.fsync(s)
save()
print('ready',flush=True)
for line in sys.stdin:
 value=json.loads(line)
 if value.get('type')=='worktree':
  receipt['worktreePath']=os.path.realpath(value['path']);save()
 elif value.get('type')=='release':
  receipt['nativeExited']=value.get('nativeExited') is True
  receipt['phase']='idle' if receipt['nativeExited'] and receipt['worktreePath'] else 'unsafe'
  save();break
os.close(s);os.close(l);os.close(d)
`

export type WorkspaceControl = {
  setWorktree(path: string): void
  release(nativeExited: boolean): Promise<void>
}

/** Trusted E2B host only. Local daemons do not gain a remote shell endpoint. */
export async function acquireCloudWorkspaceControl(input: {
  runId: string; deviceId: string; signal: AbortSignal; onLost: () => void
}, root = CLOUD_WORKSPACE_CONTROL_ROOT): Promise<WorkspaceControl> {
  input.signal.throwIfAborted()
  const child = spawn('python3', ['-I', '-u', '-c', HOLD, root, input.runId, input.deviceId], {
    env: { ...buildChildEnv(), NODE_ENV: process.env.NODE_ENV ?? 'production' }, stdio: ['pipe', 'pipe', 'ignore'],
  })
  let acquired = false, releasing = false, settled = false, output = ''
  let finished!: () => void
  const done = new Promise<void>(resolve => { finished = resolve })
  child.stdin.on('error', () => {
    // A broken pipe is loss of the execution fence. The close handler owns
    // cancellation; never let an unhandled EPIPE bypass supervisor cleanup.
    if (!settled && !releasing) child.kill('SIGTERM')
  })
  const abort = () => { if (!acquired) child.kill('SIGTERM') }
  input.signal.addEventListener('abort', abort, { once: true })
  const send = (value: unknown) => {
    if (!acquired || settled || releasing || !child.stdin.writable) throw new CodedError('terminal_control_unavailable', { detail: 'fence_lost' })
    child.stdin.write(JSON.stringify(value) + '\n')
  }
  await new Promise<void>((resolve, reject) => {
    const fail = (cause?: unknown) => reject(new CodedError('terminal_control_unavailable', { detail: 'fence_unavailable', cause }))
    child.once('error', fail)
    child.stdout.on('data', data => {
      if (acquired) return
      output += data.toString()
      if (output === 'ready\n') {
        acquired = true
        input.signal.removeEventListener('abort', abort)
        if (input.signal.aborted) { releasing = true; child.stdin.end(); fail(input.signal.reason); return }
        resolve()
      } else if (output.length > 32) { child.kill('SIGTERM'); fail() }
    })
    child.once('close', () => {
      settled = true
      input.signal.removeEventListener('abort', abort)
      finished()
      if (!acquired) fail()
      else if (!releasing) input.onLost()
    })
    if (input.signal.aborted) abort()
  })
  return {
    setWorktree(path) { send({ type: 'worktree', path }) },
    async release(nativeExited) {
      if (releasing) return done
      if (!settled) {
        send({ type: 'release', nativeExited })
        releasing = true
        child.stdin.end()
      }
      await done
    },
  }
}
