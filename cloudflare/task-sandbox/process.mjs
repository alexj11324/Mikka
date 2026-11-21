import { RpcTarget } from 'cloudflare:workers'
import { parts } from './files.mjs'

const runtime = '/opt/mikka/task-sandbox'
const user = ['--reuid=1000', '--regid=1000', '--clear-groups', '--inh-caps=-all',
  '--ambient-caps=-all', '--bounding-set=-all', '--no-new-privs']

export function processOptions(options) {
  const { command, workingDirectory: cwd, env = {}, stdin = false } = options ?? {}
  if (typeof command !== 'string' || !command || command.length > 32_768 || command.includes('\0') ||
      typeof stdin !== 'boolean' || !env || typeof env !== 'object' || Array.isArray(env)) throw Error('Invalid task process')
  if (cwd !== '/workspace') parts(cwd)
  const entries = Object.entries(env)
  if (entries.length > 64 || entries.some(([k,v]) => !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(k) ||
      typeof v !== 'string' || v.includes('\0'))) throw Error('Invalid task process environment')
  const payload = JSON.stringify({ command, cwd, env })
  if (new TextEncoder().encode(payload).length > 65_536) throw Error('Task process environment too large')
  return { stdin, payload }
}

// A private RPC handle refers to just the one process namespace started by its grant.
class TaskProcess extends RpcTarget {
  constructor(proc, finish) {
    super()
    this.proc = proc
    this.exited = false
    this.completed = proc.exitCode.then(async exitCode => {
      this.exited = true
      await finish()
      return { exitCode }
    })
    void this.completed.catch(() => {})
  }
  wait() { return this.completed }
  async kill() {
    if (!this.exited) this.proc.kill(9)
    return this.completed
  }
}

export async function taskProcess(container, { stdin, payload }, finish) {
  // Never pass per-command env to a privileged loader or shell. Only the
  // post-drop launcher consumes the fixed envelope, after checking kernel status.
  const argv = ['/usr/bin/unshare', '--mount', '--pid', '--mount-proc', '--fork', '--kill-child=KILL',
    '/usr/bin/setpriv', ...user, '/usr/bin/python3', '-I', runtime + '/exec.py']
  const proc = await container.exec(argv, { user:'0:0', cwd:'/', env:{ MIKKA_TASK_PROCESS:payload },
    stdout:'pipe', stderr:'pipe', ...(stdin ? { stdin:'pipe' } : {}) })
  return { pid:proc.pid, stdout:proc.stdout, stderr:proc.stderr, ...(stdin ? { stdin:proc.stdin } : {}),
    handle:new TaskProcess(proc, finish) }
}

export async function stopTaskProcesses(container) {
  const proc = await container.exec(['/usr/bin/python3','-I',runtime + '/quiesce.py'], {user:'0:0'})
  const output = await proc.output()
  if (output.exitCode !== 0) throw Error('Task workspace safe point unavailable')
}
