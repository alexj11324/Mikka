/** External API/PTY acceptance on an owned, fresh private candidate VM.
 * No Task, Agent, subscription, model, credential store or production API is used.
 * The caller creates and finally destroys the VM. This probe additionally closes
 * its own PTY and root gateway and restores the original empty control receipt.
 * Reports contain closed checks/codes only, never tickets, URLs or shell content.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const PORT = 6084
const ROOT = '/run/mikka-terminal'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digest = value => createHash('sha256').update(value).digest('hex')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const requireCheck = (condition, code) => { if (!condition) throw new Error(code) }
const CODES = new Set(['terminal_probe_configuration', 'terminal_probe_metadata', 'terminal_probe_prepare',
  'terminal_probe_install', 'terminal_probe_ready', 'terminal_probe_health', 'terminal_probe_unauthorized',
  'terminal_probe_stream', 'terminal_probe_protocol', 'terminal_probe_output_limit', 'terminal_probe_output_timeout',
  'terminal_probe_input', 'terminal_probe_stdout', 'terminal_probe_resize', 'terminal_probe_stdin',
  'terminal_probe_exit', 'terminal_probe_post_exit', 'terminal_probe_cleanup'])
const failure = error => CODES.has(error?.message) ? error.message : 'terminal_probe_transport'

// These scripts run only through the SDK's root channel. The existing installer
// must already have supplied the real execution fence; this probe never repairs
// a missing installer or bypasses the product's root-owned, fixed-inode check.
function prepareScript(configuration) {
  return `# workspace-terminal-prepare
import fcntl,json,os,pwd,socket,stat
from pathlib import Path
cfg=json.loads(${JSON.stringify(JSON.stringify(configuration))})
probe=Path(cfg['probePath']); root=Path('${ROOT}'); control=Path('/run/mikka-review-control')
try:
 if os.geteuid()!=0: raise ValueError()
 account=pwd.getpwnam('user')
 directory=os.open(control,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 info=os.fstat(directory)
 if info.st_uid!=0 or info.st_mode&0o022: raise ValueError()
 def fixed(name,flags):
  fd=os.open(name,flags|os.O_NOFOLLOW,dir_fd=directory); meta=os.fstat(fd)
  if not stat.S_ISREG(meta.st_mode) or meta.st_uid!=0 or meta.st_nlink!=1: raise ValueError()
  return fd
 version=fixed('version',os.O_RDONLY)
 if os.fstat(version).st_mode&0o022 or os.read(version,16)!=b'1\\n': raise ValueError()
 os.close(version)
 lock=fixed('machine.lock',os.O_RDWR); fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 receipt=fixed('machine.json',os.O_RDWR)
 if os.read(receipt,16385)!=b'': raise ValueError()
 if probe.exists() or probe.is_symlink() or root.exists() or root.is_symlink(): raise ValueError()
 listener=socket.socket(); listener.bind(('0.0.0.0',${PORT})); listener.close()
 meta=os.fstat(receipt)
 cfg['receiptDev']=meta.st_dev; cfg['receiptIno']=meta.st_ino
 probe.mkdir(mode=0o711)
 manifest=probe/'fixture.json'; manifest.write_text(json.dumps(cfg)); manifest.chmod(0o600)
 root.mkdir(mode=0o700)
 marker=root/'acceptance-fixture'; marker.write_text(cfg['fixtureId']); marker.chmod(0o600)
 worktree=Path(cfg['scope']['worktreePath']); worktree.mkdir(mode=0o700)
 os.chown(worktree,account.pw_uid,account.pw_gid)
 value={'version':1,'runId':cfg['scope']['runId'],'deviceId':cfg['scope']['deviceId'],
  'worktreePath':str(worktree),'phase':'idle','nativeExited':True}
 os.ftruncate(receipt,0); os.lseek(receipt,0,0); os.write(receipt,json.dumps(value).encode()); os.fsync(receipt)
 os.close(receipt); os.close(lock); os.close(directory)
 print(json.dumps({'prepared':True}))
except BaseException:
 print(json.dumps({'prepared':False})); raise SystemExit(1) from None
`
}

function cleanupScript(configuration, pid) {
  return `# workspace-terminal-cleanup
import base64,fcntl,hashlib,hmac,json,os,select,shutil,signal,stat,time,urllib.request,uuid
from pathlib import Path
cfg=json.loads(${JSON.stringify(JSON.stringify(configuration))})
pid=${Number.isSafeInteger(pid) && pid > 1 ? pid : 0}
probe=Path(cfg['probePath']); root=Path('${ROOT}'); control=Path('/run/mikka-review-control')
result={'leaseRevoked':False,'ptyStopped':False,'gatewayStopped':False,'receiptRestored':False,'filesRemoved':False}
try:
 if not probe.exists():
  result={key:pid==0 for key in result}
 else:
  manifest=probe/'fixture.json'
  if manifest.is_symlink() or manifest.stat().st_uid!=0: raise ValueError()
  saved=json.loads(manifest.read_text())
  if any(saved.get(key)!=cfg[key] for key in ('fixtureId','sourceCommit','probePath','scope')): raise ValueError()
  started=probe/'gateway.pid'
  if started.exists():
   recorded=json.loads(started.read_text())
   if type(recorded.get('pid')) is not int or recorded['pid']<=1 or pid not in (0,recorded['pid']): raise ValueError()
   pid=recorded['pid']
  ownedRoot=root.exists() and not root.is_symlink() and (root/'acceptance-fixture').read_text()==cfg['fixtureId']
  if root.exists() and not ownedRoot: raise ValueError()
  # Cleanup uses root loopback even when the external ingress check failed.
  # Ticket/key never leave the root channel in output, argv or environment.
  if pid:
   try:
    key=(root/'key').read_bytes(); challenge=str(uuid.uuid4())
    health=json.loads(urllib.request.urlopen('http://127.0.0.1:${PORT}/health?challenge='+challenge,timeout=3).read(2048))
    proof=hmac.new(key,('health:v1:'+challenge+':'+health['boot']+':'+health['version']).encode(),hashlib.sha256).hexdigest()
    if health['version']!=cfg['gatewaySha256'] or not hmac.compare_digest(proof,health['proof']): raise ValueError()
    body=json.dumps({'leaseIds':[cfg['scope']['sessionId']]},separators=(',',':')).encode()
    grant={key:cfg['scope'][key] for key in ('runId','ownerId','workspaceId')}
    grant.update(version=1,operation='revoke',boot=health['boot'],nonce=str(uuid.uuid4()),
     expiresAt=int(time.time()*1000)+30000,bodyDigest=hashlib.sha256(body).hexdigest())
    enc=lambda value:base64.urlsafe_b64encode(value).rstrip(b'=')
    value=enc(json.dumps(grant,separators=(',',':')).encode())
    ticket=value+b'.'+enc(hmac.new(key,value,hashlib.sha256).digest())
    request=urllib.request.Request('http://127.0.0.1:${PORT}/revoke',data=body,
     headers={'Authorization':'Bearer '+ticket.decode(),'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(request,timeout=5) as reply:
     result['leaseRevoked']=reply.status==204
    result['ptyStopped']=result['leaseRevoked']
   except BaseException:
    pass
   # Pin the SDK-owned process before signalling; never target a reused PID.
   try:
    fd=os.pidfd_open(pid)
    born=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
    if born!=recorded['born']: raise ValueError()
    command=Path('/proc/'+str(pid)+'/cmdline').read_bytes().split(b'\\0')
    if str(probe/'gateway.py').encode() not in command: raise ValueError()
    signal.pidfd_send_signal(fd,signal.SIGKILL)
    result['gatewayStopped']=bool(select.select([fd],[],[],5)[0]); os.close(fd)
   except ProcessLookupError:
    result['gatewayStopped']=True
  else:
   result['leaseRevoked']=result['ptyStopped']=result['gatewayStopped']=True
  lock=os.open(control/'machine.lock',os.O_RDWR|os.O_NOFOLLOW)
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  fd=os.open(control/'machine.json',os.O_RDWR|os.O_NOFOLLOW); meta=os.fstat(fd)
  if meta.st_dev!=saved['receiptDev'] or meta.st_ino!=saved['receiptIno']: raise ValueError()
  current=os.read(fd,16385)
  if current:
   value=json.loads(current)
   if any(value.get(key)!=cfg['scope'][key] for key in ('runId','deviceId','worktreePath')): raise ValueError()
  if result['gatewayStopped'] and result['ptyStopped']:
   os.ftruncate(fd,0); os.fsync(fd); result['receiptRestored']=True
  os.close(fd); os.close(lock)
  if result['receiptRestored']:
   if ownedRoot: shutil.rmtree(root)
   shutil.rmtree(probe)
   result['filesRemoved']=not root.exists() and not probe.exists()
except BaseException:
 pass
print(json.dumps(result))
`
}

async function jsonReply(response) {
  const reader = response.body?.getReader()
  requireCheck(reader && Number(response.headers.get('content-length') ?? 0) <= 4096, 'terminal_probe_protocol')
  const chunks = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      requireCheck(size <= 4096, 'terminal_probe_protocol')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

// Consume actual SSE frames, not command echoes. Each condition has a bounded
// event-driven deadline; there is no readiness/HTTP/database polling loop.
function readEvents(response) {
  const reader = response.body.getReader(), decoder = new TextDecoder()
  const state = { output: '', session: null, ended: null, ready: false }
  let buffer = '', bytes = 0, closed = false, reason = null
  const waiting = new Set()
  const notify = () => {
    for (const item of waiting) {
      if (reason || item.predicate(state) || closed) {
        waiting.delete(item); clearTimeout(item.timer)
        if (reason || !item.predicate(state)) item.reject(new Error(reason ?? 'terminal_probe_stream'))
        else item.resolve(state)
      }
    }
  }
  const completed = (async () => {
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        requireCheck(bytes <= 262_144, 'terminal_probe_output_limit')
        buffer += decoder.decode(next.value, { stream: true })
        requireCheck(buffer.length <= 65_536, 'terminal_probe_output_limit')
        while (buffer.includes('\n\n')) {
          const end = buffer.indexOf('\n\n'), frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          const lines = frame.split('\n'), kind = lines.find(line => line.startsWith('event: '))?.slice(7)
          const data = JSON.parse(lines.find(line => line.startsWith('data: '))?.slice(6) ?? 'null')
          if (kind === 'output') {
            requireCheck(typeof data?.text === 'string', 'terminal_probe_protocol')
            state.ready = true; state.output += data.text
          } else if (kind === 'session') state.session = data
          else if (kind === 'ended') { state.ended = data; notify(); return }
          notify()
        }
      }
    } catch (error) { reason = failure(error) }
    finally { closed = true; notify() }
  })()
  return {
    until(predicate) {
      if (predicate(state)) return Promise.resolve(state)
      if (closed) return Promise.reject(new Error(reason ?? 'terminal_probe_stream'))
      return new Promise((resolve, reject) => {
        const item = { predicate, resolve, reject }
        item.timer = setTimeout(() => { waiting.delete(item); reject(new Error('terminal_probe_output_timeout')) }, 10_000)
        waiting.add(item)
      })
    },
    async close() { await reader.cancel().catch(() => {}); await completed; reader.releaseLock(); state.output = ''; buffer = '' },
  }
}

export async function probeWorkspaceTerminal(sandbox, { sourceCommit, fixtureId, fetchImpl = fetch }) {
  const report = { version: 1, sourceCommit: /^[a-f0-9]{40}$/.test(sourceCommit ?? '') ? sourceCommit : null,
    fixtureId: /^[A-Za-z0-9_-]{1,80}$/.test(fixtureId ?? '') ? fixtureId : null,
    gatewaySha256: null, checks: {}, statuses: {}, exitCode: null,
    cleanup: { leaseRevoked: false, ptyStopped: false, gatewayStopped: false, receiptRestored: false, filesRemoved: false },
    passed: false, failure: null }
  let prepared = false, configuration, process, stream, key, abort
  try {
    requireCheck(report.sourceCommit && report.fixtureId && typeof fetchImpl === 'function', 'terminal_probe_configuration')
    const info = await sandbox.getInfo()
    requireCheck(info.state === 'running' && info.metadata?.sourceCommit === sourceCommit && info.metadata?.fixtureId === fixtureId
      && info.metadata?.application === 'mikka-workspace-ingress-acceptance', 'terminal_probe_metadata')
    report.checks.metadata = true
    const host = sandbox.getHost(PORT)
    requireCheck(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:e2b\.app|e2b\.dev)$/i.test(host), 'terminal_probe_configuration')
    const origin = `https://${host}`
    const source = await readFile(new URL('./terminal-gateway.py', import.meta.url), 'utf8')
    report.gatewaySha256 = digest(source)
    const probePath = `/opt/mikka/terminal-acceptance-${digest(fixtureId).slice(0, 24)}`
    const scope = Object.fromEntries(['runId', 'workspaceId', 'taskId', 'deviceId', 'repoId', 'sessionId'].map(name => [name, randomUUID()]))
    Object.assign(scope, { ownerId: 'synthetic-terminal-acceptance', bindingId: digest(randomUUID()),
      credentialId: `session:${randomUUID()}`, worktreePath: `${probePath}/worktree`, machineEpoch: 1,
      sessionExpiresAt: Date.now() + 180_000 })
    configuration = { sourceCommit, fixtureId, probePath, scope, gatewaySha256: report.gatewaySha256 }
    // Mark the attempt before dispatch: a lost SDK response still needs cleanup.
    prepared = true
    const setup = await sandbox.commands.run(`python3 -I -c ${quote(prepareScript(configuration))}`, { user: 'root', timeoutMs: 10_000 })
    requireCheck(setup.exitCode === 0 && JSON.parse(setup.stdout).prepared === true, 'terminal_probe_prepare')
    report.checks.freshControl = true
    key = randomBytes(32)
    await sandbox.files.write([{ path: `${probePath}/gateway.py`, data: source },
      { path: `${ROOT}/key`, data: Uint8Array.from(key).buffer }], { user: 'root' })
    const modes = await sandbox.commands.run(`chmod 444 ${quote(`${probePath}/gateway.py`)} && chmod 600 ${ROOT}/key`, { user: 'root', timeoutMs: 5_000 })
    requireCheck(modes.exitCode === 0, 'terminal_probe_install')
    let resolveReady, rejectReady, readiness = '', readyTimer
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject
      readyTimer = setTimeout(() => reject(new Error('terminal_probe_ready')), 10_000) })
    // The SDK can fail before it yields a handle; still observe this rejection.
    void ready.catch(() => {})
    // Start the actual module's main, including its production listener/socket
    // mark. A custom in-process test server would bypass the ingress feature.
    const launch = `import json,os,sys\nfrom pathlib import Path\np=Path(${JSON.stringify(probePath)})\nborn=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19]\n(p/'gateway.pid').write_text(json.dumps({'pid':os.getpid(),'born':born}))\nos.execv(sys.executable,[sys.executable,'-I','-u',str(p/'gateway.py')])\n`
    try {
      process = await sandbox.commands.run(`exec python3 -I -c ${quote(launch)}`, {
      user: 'root', background: true, timeoutMs: 0, onStderr: () => {}, onStdout: value => {
        readiness += value
        if (readiness === 'terminal-ready\n') resolveReady()
        else if (readiness.length >= 128 || readiness.includes('\n')) rejectReady(new Error('terminal_probe_ready'))
      },
      })
      void process.wait().then(() => rejectReady(new Error('terminal_probe_ready')), () => rejectReady(new Error('terminal_probe_ready')))
      await ready
    } finally { clearTimeout(readyTimer) }
    requireCheck(Number.isSafeInteger(process.pid) && process.pid > 1, 'terminal_probe_ready')
    report.checks.gatewayReady = true
    abort = new AbortController()
    const request = (path, options = {}) => fetchImpl(`${origin}${path}`, { ...options, cache: 'no-store', redirect: 'error',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(path === '/stream' ? 90_000 : 15_000)]) })
    // One bounded setup delay for envd's listener scan, shared with the existing
    // ingress acceptance. No retry or successful-sample selection is performed.
    await new Promise(resolve => setTimeout(resolve, 1500))
    const challenge = randomUUID(), healthResponse = await request(`/health?challenge=${challenge}`)
    requireCheck(healthResponse.status === 200, 'terminal_probe_health')
    const health = await jsonReply(healthResponse)
    requireCheck(UUID.test(health?.boot ?? '') && health.version === report.gatewaySha256 && /^[a-f0-9]{64}$/.test(health.proof ?? ''), 'terminal_probe_health')
    const expected = createHmac('sha256', key).update(`health:v1:${challenge}:${health.boot}:${health.version}`).digest()
    requireCheck(timingSafeEqual(Buffer.from(health.proof, 'hex'), expected), 'terminal_probe_health')
    report.checks.authenticatedHealth = true
    const call = async (operation, value) => {
      const body = value === undefined ? '' : JSON.stringify(value)
      const grant = { ...scope, version: 1, operation, boot: health.boot, nonce: randomUUID(),
        expiresAt: Date.now() + 30_000, bodyDigest: digest(body) }
      const encoded = Buffer.from(JSON.stringify(grant)).toString('base64url')
      const ticket = `${encoded}.${createHmac('sha256', key).update(encoded).digest('base64url')}`
      return request(`/${operation}`, { method: operation === 'stream' ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json' },
        ...(value === undefined ? {} : { body }) })
    }
    for (const [name, path, options] of [['unauthorizedStream', '/stream', {}],
      ['unauthorizedInput', '/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: '' }) }]]) {
      const response = await request(path, options)
      report.statuses[name] = response.status; await response.body?.cancel()
      requireCheck(response.status === 401 || response.status === 403, 'terminal_probe_unauthorized')
      report.checks[name] = true
    }
    const response = await call('stream')
    report.statuses.stream = response.status
    requireCheck(response.status === 200 && response.body && response.headers.get('content-type')?.startsWith('text/event-stream'), 'terminal_probe_stream')
    stream = readEvents(response)
    const started = await stream.until(state => state.ready && state.session !== null)
    requireCheck(started.session.terminalSessionId === scope.sessionId && started.session.runId === scope.runId
      && started.session.ownerId === scope.ownerId && started.session.machineStatus === 'running'
      && started.session.expiresAt === scope.sessionExpiresAt
      && JSON.stringify(started.session.rights) === JSON.stringify(['read', 'write', 'resize', 'close']), 'terminal_probe_protocol')
    report.checks.streamReady = true
    const write = async (operation, value, code = 'terminal_probe_input') => {
      const result = await call(operation, value); const status = result.status; await result.body?.cancel()
      requireCheck(status === 204, code)
      return status
    }
    const input = data => write('input', { data, requestId: randomUUID() })
    await input("stty -echo; PS1=''; printf '\\n__TERMINAL_READY__\\n'\n")
    await stream.until(state => state.output.includes('\r\n__TERMINAL_READY__\r\n'))
    await input("printf '__TERMINAL_STDOUT__\\n'\n")
    await stream.until(state => state.output.includes('\r\n__TERMINAL_STDOUT__\r\n'))
    report.checks.stdout = true
    report.statuses.resize = await write('resize', { cols: 111, rows: 37 }, 'terminal_probe_resize')
    await input("stty size; printf '__TERMINAL_SIZE__\\n'\n")
    const resized = await stream.until(state => state.output.includes('__TERMINAL_SIZE__\r\n'))
    requireCheck(resized.output.includes('\r\n37 111\r\n'), 'terminal_probe_resize')
    report.checks.resize = true
    await input("printf '__TERMINAL_READ__\\n'; read -r answer; test \"$answer\" = fixture-input && printf '__TERMINAL_STDIN__\\n'\n")
    await stream.until(state => state.output.includes('\r\n__TERMINAL_READ__\r\n'))
    await input('fixture-input\n')
    await stream.until(state => state.output.includes('\r\n__TERMINAL_STDIN__\r\n'))
    report.checks.stdin = true
    await input('exit 7\n')
    const ended = await stream.until(state => state.ended !== null)
    report.exitCode = Number.isSafeInteger(ended.ended.exitCode) ? ended.ended.exitCode : null
    requireCheck(report.exitCode === 7, 'terminal_probe_exit')
    report.checks.exit = true
    const after = await call('input', { data: '', requestId: randomUUID() })
    report.statuses.postExit = after.status; await after.body?.cancel()
    requireCheck(after.status === 409, 'terminal_probe_post_exit')
    report.checks.postExitRefused = true
  } catch (error) { report.failure = failure(error) }
  finally {
    abort?.abort()
    await stream?.close().catch(() => {})
    if (prepared) {
      try {
        const result = await sandbox.commands.run(`python3 -I -c ${quote(cleanupScript(configuration, process?.pid))}`, { user: 'root', timeoutMs: 20_000 })
        const value = JSON.parse(result.stdout)
        for (const name of Object.keys(report.cleanup)) report.cleanup[name] = result.exitCode === 0 && value[name] === true
      } catch { /* The closed report requires the caller's final VM teardown. */ }
    }
    if (process && !report.cleanup.gatewayStopped) await process.kill().catch(() => {})
    // The SDK guarantees disconnect stops callbacks, but deliberately does not
    // await its event iterator. The root pidfd/revoke acknowledgements above
    // prove process cleanup even if that transport iterator never drains.
    if (process) await process.disconnect().catch(() => {})
    key?.fill(0)
    if (prepared && !Object.values(report.cleanup).every(Boolean)) report.failure ??= 'terminal_probe_cleanup'
  }
  report.passed = report.failure === null && Object.values(report.cleanup).every(Boolean) && report.checks.postExitRefused === true
  return report
}
