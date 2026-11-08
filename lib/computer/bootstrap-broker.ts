import { createHash } from 'node:crypto'
import type { Sandbox, CommandHandle, CommandInputHandle, CommandResult } from 'e2b'
import { WORKER_BOOTSTRAP_BROKER_SOURCE } from '../../packages/daemon/src/cloud-bootstrap-broker.mjs'
import { quoteShell } from './registration-command'

export const WORKER_BROKER_ATTESTATION = 'mikka-worker-broker-attestation '
export const WORKER_BROKER_SHA256 = createHash('sha256').update(WORKER_BOOTSTRAP_BROKER_SOURCE).digest('hex')

export type WorkerBrokerConfig = {
  runId: string
  leaseId: string
  workerSha: string
  handoff: string
  directory: string
  prepare: string
  publish: string
  wake: string
  wakeReceipt: string
  start: string
  timeoutMs: number
  registrationTimeoutMs: number
  runtimeRoot?: string
}

/** This small loader is the only code sent for capable workers. The broker is
 * installed by the actual selected worker build; an older release has no file.
 * Never execute a resource just because its filename or capability is present. */
export const WORKER_BROKER_LOADER = String.raw`
import{constants,openSync,closeSync,fstatSync,readFileSync,realpathSync,lstatSync}from'node:fs';
import{join,dirname,basename}from'node:path';import{createHash}from'node:crypto';
const c=JSON.parse(process.argv[1]);let sourceSha=null,bytes;
const read=(path,max)=>{let fd;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(fd);if(!s.isFile()||s.size>max||s.uid!==process.getuid()||(s.mode&0o022))throw Error('untrusted');return readFileSync(fd)}finally{if(fd!==undefined)closeSync(fd)}};
try{
const runtime=realpathSync(c.runtimeRoot||'/opt/mikka');
const marker=read(join(runtime,'worker-source-sha'),512).toString('utf8').trim();if(/^[a-f0-9]{40}$/.test(marker))sourceSha=marker;
const link=join(runtime,'worker'),ls=lstatSync(link),source=realpathSync(link),release=dirname(source);
if(!ls.isSymbolicLink()||ls.uid!==process.getuid()||basename(source)!=='source'||dirname(release)!==join(runtime,'releases')||!/^[a-f0-9]{40}$/.test(basename(release)))throw Error('legacy');
for(const p of[release,source]){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o022))throw Error('legacy')}
const dir=join(source,'packages/daemon/dist/cloud'),file=join(dir,'bootstrap-broker.mjs'),cap=join(dir,'runtime-capabilities.json');
if(realpathSync(file)!==file||realpathSync(cap)!==cap)throw Error('legacy');
const a=JSON.parse(read(cap,512).toString('utf8'));
if(Object.keys(a).sort().join(',')!=='registrationNoticeVersion,workerSha'||a.registrationNoticeVersion!==1||a.workerSha!==c.workerSha||sourceSha!==c.workerSha||read(join(release,'worker-ready.sha'),512).toString('utf8').trim()!==c.workerSha)throw Error('legacy');
bytes=read(file,32768);if(createHash('sha256').update(bytes).digest('hex')!==c.brokerSha256)throw Error('legacy');
}catch{bytes=undefined}
if(!bytes)process.stdout.write('mikka-worker-broker-attestation '+JSON.stringify({version:1,runId:c.runId,leaseId:c.leaseId,sourceSha,broker:false})+'\n');
else await import('data:text/javascript;base64,'+bytes.toString('base64'));
`

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function workerBrokerCommand(config: WorkerBrokerConfig) {
  if (!UUID.test(config.runId) || !UUID.test(config.leaseId) || !/^[a-f0-9]{40}$/.test(config.workerSha) ||
    !Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 40_000 ||
    !Number.isInteger(config.registrationTimeoutMs) || config.registrationTimeoutMs <= 0 || config.registrationTimeoutMs > 30_000 ||
    !config.handoff.endsWith('/thread-' + config.leaseId + '.json')) throw Error('Invalid worker broker configuration')
  return 'exec /opt/mikka/runtime/node/bin/node --input-type=module -e ' + quoteShell(WORKER_BROKER_LOADER) +
    ' ' + quoteShell(JSON.stringify({ ...config, brokerSha256: WORKER_BROKER_SHA256 }))
}

async function bounded<T>(value: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms) })]) }
  finally { clearTimeout(timer) }
}

type Attestation = { version: 1; runId: string; leaseId: string; sourceSha: string | null; broker: boolean }
type Upload = { path: string; data: string }
export type WorkerBootstrapBroker = {
  readonly sourceSha: string
  readonly active: boolean
  readonly result: Promise<CommandResult>
  assertAwaitingUpload(): void
  commit(files: Upload[], identity: { deviceId: string; workspaceId: string; tokenSha256: string }): Promise<void>
  close(): Promise<void>
}

export async function openWorkerBootstrapBroker(sandbox: Pick<Sandbox, 'commands'>, config: WorkerBrokerConfig,
  options: { requestTimeoutMs?: number; signal?: AbortSignal; onStdout?: (chunk: string) => void } = {}): Promise<WorkerBootstrapBroker> {
  let resolve!: (value: Attestation) => void, reject!: (error: unknown) => void, output = '', observed = false
  const attestation = new Promise<Attestation>((yes, no) => { resolve = yes; reject = no })
  void attestation.catch(() => {})
  let child: CommandHandle | undefined, input: CommandInputHandle | undefined, completed = false, sent = false, closing: Promise<void> | undefined
  const inputAbort = new AbortController()
  const onStdout = (chunk: string) => {
    options.onStdout?.(chunk)
    if (observed) return
    output += chunk
    if (Buffer.byteLength(output) > 2048) { reject(Error('Worker broker attestation too large')); return }
    const newline = output.indexOf('\n')
    if (newline < 0) return
    const line = output.slice(0, newline)
    try {
      if (!line.startsWith(WORKER_BROKER_ATTESTATION)) throw Error('Worker broker attestation missing')
      const value = JSON.parse(line.slice(WORKER_BROKER_ATTESTATION.length))
      if (!value || Object.keys(value).sort().join(',') !== 'broker,leaseId,runId,sourceSha,version' ||
        value.version !== 1 || value.runId !== config.runId || value.leaseId !== config.leaseId ||
        typeof value.broker !== 'boolean' || !(value.sourceSha === null || /^[a-f0-9]{40}$/.test(value.sourceSha)) ||
        (value.broker && value.sourceSha !== config.workerSha)) throw Error('Worker broker attestation invalid')
      observed = true; resolve(value)
    } catch (cause) { reject(new Error('Worker broker attestation invalid', { cause })) }
  }
  let result: Promise<CommandResult> = Promise.reject(Error('Worker broker has not started'))
  void result.catch(() => {})
  let noteExit!: () => void
  const exited = new Promise<void>(resolve => { noteExit = resolve })
  const close = () => closing ??= (async () => {
    let failure: Error | undefined
    try {
      if (child && !completed) {
        let abortDelivered = false
        if (input) {
          try {
            await input.send(JSON.stringify({ version: 1, kind: 'abort', runId: config.runId, leaseId: config.leaseId }) + '\n')
            // send() only queues bytes in E2B 2.61; close() acknowledges the
            // existing stream. Do not confuse a broken response with exit.
            await bounded(input.close(), 2500, 'Worker broker abort was not acknowledged')
            abortDelivered = true
          } catch (cause) {
            if (sent) throw new Error('Worker broker cancellation is unconfirmed', { cause })
          }
        }
        if (abortDelivered) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1500) })]) }
          finally { clearTimeout(timer) }
        }
        if (child.exitCode !== undefined) completed = true
        // Before commit there are no publication children. After commit an
        // acknowledged abort first drains the broker-owned command group.
        // With a broken input stream, leave the bounded broker/recovery owner
        // intact rather than killing only its parent and orphaning children.
        if (!completed) await sandbox.commands.kill(child.pid, { requestTimeoutMs: 2500, signal: AbortSignal.timeout(2500) })
      }
      if (child) await bounded(result.catch(() => undefined), 2500, 'Worker broker did not drain')
    } catch (cause) {
      failure = cause instanceof Error ? cause : new Error('Worker broker cleanup failed', { cause })
    } finally {
      try {
        if (input) {
          try { await bounded(input.close(), 2500, 'Worker broker input did not close') }
          catch (cause) { if (!completed) failure ??= new Error('Worker broker input cleanup is unconfirmed', { cause }) }
        }
      } finally {
        inputAbort.abort()
        try { await child?.disconnect() }
        catch (cause) { failure ??= new Error('Worker broker response cleanup failed', { cause }) }
      }
    }
    if (failure) throw failure
  })()
  try {
    child = await sandbox.commands.run(workerBrokerCommand(config), {
      user: 'root', timeoutMs: config.timeoutMs * 2, ...options, background: true, stdin: true, onStdout,
    })
    result = child.wait().then(value => { completed = true; noteExit(); if (!observed) reject(Error('Worker broker exited without attestation')); return value },
      cause => { if (child?.exitCode !== undefined) { completed = true; noteExit() } reject(cause); throw cause })
    void result.catch(() => {})
    const proof = await attestation
    if (proof.broker) {
      input = sandbox.commands.streamInput(child.pid, { timeoutMs: config.timeoutMs * 2,
        signal: inputAbort.signal })
    } else await result
    const assertAwaitingUpload = () => {
      if (closing || completed || sent || !input || !proof.broker) throw Error('Worker broker is not awaiting upload')
      options.signal?.throwIfAborted()
    }
    return {
      sourceSha: proof.sourceSha ?? '', active: proof.broker, result, close, assertAwaitingUpload,
      async commit(files, identity) {
        assertAwaitingUpload()
        if (!UUID.test(identity.deviceId) || !UUID.test(identity.workspaceId) || !/^[a-f0-9]{64}$/.test(identity.tokenSha256) ||
          files.length !== 4 || files.some((file, index) => file.path !== config.handoff + ['', '.run', '.claude', '.codex'][index]))
          throw Error('Worker broker upload identity invalid')
        options.signal?.throwIfAborted()
        sent = true
        await input!.send(JSON.stringify({ version: 1, kind: 'commit', runId: config.runId, leaseId: config.leaseId, ...identity,
          files: files.map(file => ({ bytes: Buffer.byteLength(file.data), sha256: createHash('sha256').update(file.data).digest('hex') })) }) + '\n')
      },
    }
  } catch (cause) {
    try { await close() } catch { /* Preserve the original failure; the remote broker has its own bounded lifetime. */ }
    throw new Error('Worker broker unavailable', { cause })
  }
}
