import 'server-only'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sandbox } from 'e2b'
import { runtimeRefreshRefusal } from './runtime-refresh-refusal'
import { recordCloudBootstrapPhases } from './startup-tracing'

export const OFFICIAL_E2B_TEMPLATES = ['desktop', 'claude', 'codex'] as const
export type OfficialE2BTemplate = typeof OFFICIAL_E2B_TEMPLATES[number]
export function isOfficialE2BTemplate(template: string): template is OfficialE2BTemplate {
  return (OFFICIAL_E2B_TEMPLATES as readonly string[]).includes(template)
}

/** An idle refresh supplies one remaining budget; other runtime paths keep
 * their existing timeouts. An SDK timeout is not proof a remote process died. */
export type RuntimeBudget = (maximumMs: number) => number
export function runtimeRequestOptions(budget?: RuntimeBudget, maximumMs = 30_000) {
  if (!budget) return {}
  const requestTimeoutMs = budget(maximumMs)
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > maximumMs) throw new Error('Worker runtime refresh deadline')
  return { requestTimeoutMs, signal: AbortSignal.timeout(requestTimeoutMs) }
}
export function runtimeCommandOptions(maximumMs: number, budget?: RuntimeBudget) {
  const request = runtimeRequestOptions(budget, maximumMs)
  return { timeoutMs: request.requestTimeoutMs ?? maximumMs, ...request }
}
function foregroundRuntimeCommand(command: string, maximumMs: number, budget?: RuntimeBudget) {
  const options = runtimeCommandOptions(maximumMs, budget)
  if (!budget) return { command, options }
  // Stop this foreground command remotely before the SDK disconnects. Leave
  // three seconds for KILL and two for the exit receipt; background workers
  // and desktops deliberately never use this wrapper.
  const executionMs = options.timeoutMs - 5_000
  if (executionMs <= 0) throw new Error('Worker runtime refresh deadline')
  return { command: `timeout --signal=TERM --kill-after=3s ${(executionMs / 1_000).toFixed(3)}s ${command}`, options }
}

/** New instances only: all additions live under /opt/mikka (plus the private
 * runtime authority directory). Never edit an E2B template or its packages. */
export async function bootstrapOfficialInstance(sandbox: Pick<Sandbox, 'commands'>, template: OfficialE2BTemplate,
  env: Record<string, string | undefined> = process.env,
  script = () => readFile(join(process.cwd(), 'packages/daemon/scripts/official-e2b-instance-bootstrap.sh'), 'utf8')) {
  const commit = env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT, sha = env.MIKKA_CLOUD_WORKER_SHA
  if (!isOfficialE2BTemplate(template) || !commit || !/^[a-f0-9]{40}$/.test(commit) || !sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Official worker release is not configured')
  const source = await script()
  const startedAt = Date.now()
  const result = await sandbox.commands.run(`bash -s -- ${commit} ${sha} ${template} <<'MIKKA_OFFICIAL_INSTANCE_BOOTSTRAP'\n${source}\nMIKKA_OFFICIAL_INSTANCE_BOOTSTRAP`, { user: 'root', timeoutMs: 300_000 })
  recordCloudBootstrapPhases(result.stdout, startedAt, Date.now())
  if (!result.stdout.includes(`mikka-official-instance-ready ${commit} ${sha}`)) {
    // Idempotent creation can return an already-installed instance. Verify its
    // receipt rather than treating command exit alone as successful startup.
    const receipt = await sandbox.commands.run('python3 /opt/mikka/runtime/ingress-v1/guard.py verify >/dev/null && cat /opt/mikka/worker-source-sha', { user: 'root', timeoutMs: 30_000 })
    if (receipt.stdout.trim() !== sha) throw new Error('Official worker receipt mismatch')
  }
}

/** Stage a fixed public release without changing the running worker, CLI or user home. */
export async function stageOfficialWorkerRelease(sandbox: Pick<Sandbox, 'commands'>, template: OfficialE2BTemplate, previousSha: string,
  env: Record<string, string | undefined> = process.env,
  script = () => readFile(join(process.cwd(), 'packages/daemon/scripts/official-e2b-instance-bootstrap.sh'), 'utf8'), budget?: RuntimeBudget) {
  const commit = env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT, sha = env.MIKKA_CLOUD_WORKER_SHA
  if (!isOfficialE2BTemplate(template) || !commit || !/^[a-f0-9]{40}$/.test(commit) || !sha || !/^[a-f0-9]{40}$/.test(sha) || !/^[a-f0-9]{40}$/.test(previousSha)) throw new Error('Official worker release is not configured')
  const source = await script()
  const staged = foregroundRuntimeCommand(`bash -s -- ${commit} ${sha} ${template} stage ${previousSha} <<'MIKKA_OFFICIAL_WORKER_STAGE'\n${source}\nMIKKA_OFFICIAL_WORKER_STAGE`, 180_000, budget)
  const result = await sandbox.commands.run(staged.command, { user: 'root', ...staged.options })
  if (!result.stdout.includes(`mikka-official-instance-staged ${commit} ${sha}`)) throw new Error('Official worker staging unconfirmed')
  return { sourceCommit: commit, workerSha: sha, previousSha }
}

/** Called only inside the owner's idle-machine maintenance lease and claim lock. */
export async function switchOfficialWorkerRelease(sandbox: Pick<Sandbox, 'commands'>, release: { sourceCommit: string; workerSha: string; previousSha: string },
  identity: { deviceId: string; workspaceId: string; operationId: string }, action: 'switch' | 'rollback' | 'verify' = 'switch',
  script = () => readFile(join(process.cwd(), 'packages/daemon/scripts/refresh-cloud-worker.py'), 'utf8'), budget?: RuntimeBudget) {
  if (!['switch','rollback','verify'].includes(action) || ![release.sourceCommit, release.workerSha, release.previousSha].every(value => /^[a-f0-9]{40}$/.test(value)) ||
    ![identity.deviceId, identity.workspaceId, identity.operationId].every(value => /^[a-f0-9-]{36}$/.test(value))) throw new Error('Invalid runtime maintenance identity')
  const source = await script()
  const lock = budget ? 'flock --exclusive /opt/mikka/runtime-refresh.lock ' : ''
  const switched = foregroundRuntimeCommand(`${lock}python3 - ${action} ${identity.deviceId} ${identity.workspaceId} ${release.previousSha} ${release.sourceCommit} ${release.workerSha} ${identity.operationId} <<'MIKKA_PRIVATE_RUNTIME_SWITCH'\n${source}\nMIKKA_PRIVATE_RUNTIME_SWITCH`, 30_000, budget)
  let result
  try { result = await sandbox.commands.run(switched.command, { user: 'root', ...switched.options }) }
  catch (error) { throw runtimeRefreshRefusal(error, action) ?? error }
  const receipt = JSON.parse(result.stdout)
  if (receipt.status !== (action === 'switch' ? 'switched' : action === 'rollback' ? 'restored_not_ready' : 'verified_process') || receipt.workerSha !== (action === 'rollback' ? release.previousSha : release.workerSha) || (action !== 'rollback' && receipt.workerSourceCommit !== release.sourceCommit)) throw new Error('Worker runtime switch unconfirmed')
  if (action === 'verify') {
    if (!Number.isInteger(receipt.pid) || receipt.pid<=1) throw new Error('Worker process unavailable')
    // Reuse the authenticated local RPC client: the live socket must belong to
    // that same newly started process, not an old daemon accepting a new token.
    const code = `(async()=>{const {connectDaemonInDataDir}=await import('./src/rpc/client.ts');const client=await connectDaemonInDataDir('/home/user/.mikka/worker',{name:'runtime-refresh',version:'1.0.0'});try{const status=await client.request('daemon.status');if(status.pid!==${receipt.pid}||status.deviceId!==${JSON.stringify(identity.deviceId)}||status.workspaceId!==${JSON.stringify(identity.workspaceId)})throw Error('runtime process mismatch');console.log('mikka-runtime-process-verified '+status.pid)}finally{client.close()}})().catch(()=>{process.exitCode=1})`
    const quote = (value:string) => `'${value.replaceAll("'", "'\\''")}'`
    const verified = await sandbox.commands.run(`cd /opt/mikka/worker/packages/daemon && PATH=/opt/mikka/runtime/node/bin:$PATH ./node_modules/.bin/tsx --eval ${quote(code)}`, {user:'user',...runtimeCommandOptions(10_000, budget)})
    if (verified.stdout.trim()!==`mikka-runtime-process-verified ${receipt.pid}`) throw new Error('Worker RPC process unconfirmed')
  }
  return receipt as { status: string; previousWorkerSha: string; workerSourceCommit: string; workerSha: string }
}
