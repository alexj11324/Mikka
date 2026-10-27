import 'server-only'
import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Sandbox } from 'e2b'
import { HOSTED_NATIVE_IMAGE } from '@mikka/protocol/subscription'

const lifetime = 15 * 60_000
export type DesktopLease = { botId: string; ownerId: string; display: number; epoch: number; controlledBy: string | null; controlUntil: number; computerAllowed: boolean; policyVersion: number }
const options = () => {
  if (!process.env.E2B_API_KEY) throw new Error('Cloud computer is not configured')
  return { apiKey: process.env.E2B_API_KEY, timeoutMs: lifetime, proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy }
}

export async function connectComputer(id: string) {
  return Sandbox.connect(id, options())
}

export async function computerState(id: string) {
  const info = await Sandbox.getInfo(id, options())
  return info.state === 'paused' ? 'sleeping' : 'running'
}

/** Keep a machine with an active daemon alive; inactivity still expires it. */
export async function renewComputerLifetime(id: string) {
  await Sandbox.setTimeout(id, lifetime, options())
}

/** Template is built from scripts/e2b/bootstrap.sh, never a third-party CUA image. */
export async function createComputer(workspaceId: string, operationId: string) {
  const template = process.env.E2B_COMPUTER_TEMPLATE
  if (!template) throw new Error('Cloud desktop template is not configured')
  return Sandbox.create(template, { ...options(), idempotencyKey: operationId,
    metadata: { application: 'mikka', workspaceId },
    lifecycle: { onTimeout: 'pause', autoResume: false },
  })
}

/** Thread sandboxes are created from an owner-scoped workspace snapshot.
 * They never inherit the Bot machine's running desktop or processes. */
export const threadMachineProvider = {
  async create(snapshotId: string, runId: string, operationId: string) {
    const sandbox = await Sandbox.create(snapshotId, { ...options(), idempotencyKey: operationId,
      metadata: { application: 'mikka-thread', runId },
      lifecycle: { onTimeout: 'pause', autoResume: false },
    })
    return { sandboxId: sandbox.sandboxId }
  },
  async resume(sandboxId: string) { await Sandbox.connect(sandboxId, options()) },
  async pause(sandboxId: string) { await Sandbox.pause(sandboxId, options()) },
  async kill(sandboxId: string) { await Sandbox.kill(sandboxId, options()) },
}

/** A clean staging sandbox contains the pinned worker image, but no Bot
 * desktop, browser profile, worker credential or E2B control-plane key. */
export async function createWorkspaceSnapshotStage() {
  const template = process.env.E2B_COMPUTER_TEMPLATE
  if (!template) throw new Error('Cloud desktop template is not configured')
  return Sandbox.create(template, { ...options(), lifecycle: { onTimeout: 'kill' } })
}

export async function createWorkspaceSnapshot(stage: Sandbox) {
  return stage.createSnapshot({ mode: 'filesystem' })
}

/** A result download uses a disposable instance; it must not remain paused
 * and billed if the client disconnects or the serving function stops. */
export async function createResultReader(snapshotId: string, runId: string) {
  return Sandbox.create(snapshotId, { ...options(), metadata: { application: 'mikka-thread-result', runId }, lifecycle: { onTimeout: 'kill' } })
}

export async function deleteWorkspaceSnapshot(snapshotId: string) {
  await Sandbox.deleteSnapshot(snapshotId, options())
}

export type SubagentLease = { subagentId: string; botId: string; workspaceId: string; ownerId: string; epoch: number; controlledBy: string | null; controlUntil: number; computerAllowed: boolean; policyVersion: number; stopRequested: boolean }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const validSubagent = (id: string) => { if (!uuid.test(id)) throw new Error('Invalid subagent') }

async function ensureCookieRuntime(sandbox: Sandbox) {
  for (const name of ['cookie-manager.mjs', 'cookie-sync.mjs', 'desktop-chrome.mjs']) {
    await sandbox.files.write(`/opt/mikka/computer/${name}`, await readFile(join(process.cwd(), 'scripts/e2b', name), 'utf8'), { user: 'root' })
  }
  await sandbox.commands.run('mkdir -p /home/user/.mikka; flock -n /home/user/.mikka/cookie-manager.lock /usr/local/bin/node /opt/mikka/computer/cookie-manager.mjs', { user: 'user', background: true, timeoutMs: 0 })
  await sandbox.commands.run('for i in $(seq 1 50); do test -S /home/user/.mikka/shared-cookies/manager.sock && exit 0; sleep .2; done; exit 1', { user: 'user', timeoutMs: 15_000 })
}

export async function installSubagentRuntime(sandbox: Sandbox) {
  await ensureCookieRuntime(sandbox)
  for (const name of ['subagent-browser.mjs', 'subagent-egress.mjs', 'subagent-rpc.mjs', 'subagent-viewer.py', 'subagent-command.py', 'start-subagent.sh']) {
    await sandbox.files.write(`/opt/mikka/computer/${name}`, await readFile(join(process.cwd(), 'scripts/e2b', name), 'utf8'), { user: 'root' })
  }
  // E2B exposes loopback ports. The root-owned proxy permits only TCP sockets
  // attributed by the kernel to Chromium's unprivileged account.
  await sandbox.commands.run('install -d -o root -g root -m 0711 /run/mikka-subagent; flock -n /run/mikka-subagent/egress.lock env MIKKA_BROWSER_UID=$(id -u user) /usr/local/bin/node /opt/mikka/computer/subagent-egress.mjs', { user: 'root', background: true, timeoutMs: 0 })
  await sandbox.commands.run('for i in $(seq 1 50); do [ "$(curl -s -o /dev/null -w "%{http_code}" --proxy http://127.0.0.1:6082 http://127.0.0.1:6080/ --noproxy "")" = 403 ] && exit 0; sleep .2; done; exit 1', { user: 'user', timeoutMs: 15_000 })
  await sandbox.commands.run('install -d -o root -g root -m 0711 /run/mikka-subagent; flock -n /run/mikka-subagent/gateway.lock /usr/bin/python3 /opt/mikka/computer/subagent-viewer.py', { user: 'root', background: true, timeoutMs: 0 })
  await sandbox.commands.run(`for i in $(seq 1 50); do [ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6081/subagents/00000000-0000-4000-8000-000000000000)" = 401 ] && exit 0; sleep .2; done; exit 1`, { user: 'root', timeoutMs: 15_000 })
}

export async function startSubagentBrowser(sandbox: Sandbox, id: string) {
  validSubagent(id)
  await sandbox.commands.run(`bash /opt/mikka/computer/start-subagent.sh ${id} > /tmp/mikka-subagent-${id}.log 2>&1`, { user: 'user', background: true, timeoutMs: 0 })
  await sandbox.commands.run(`for i in $(seq 1 100); do python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.close()' /home/user/.mikka/subagents/${id}/browser.sock 2>/dev/null && exit 0; sleep .2; done; exit 1`, { user: 'user', timeoutMs: 25_000 })
}

/** The state file is root-written and user-readable; its lock serializes
 * approved agent actions, viewer input, takeover, stop and policy revocation. */
export async function syncSubagentLease(sandbox: Sandbox, lease: SubagentLease) {
  validSubagent(lease.subagentId); validSubagent(lease.botId); validSubagent(lease.workspaceId)
  const path = `/run/mikka-subagent/${lease.subagentId}`
  await sandbox.commands.run(`touch ${path}.lock; chown root:$(id -gn user) ${path}.lock; chmod 660 ${path}.lock`, { user: 'root', timeoutMs: 10_000 })
  await sandbox.files.write(`${path}.next`, JSON.stringify(lease), { user: 'root' })
  await sandbox.commands.run(`chown root:$(id -gn user) ${path}.next; chmod 640 ${path}.next; flock -x ${path}.lock mv ${path}.next ${path}.json`, { user: 'root', timeoutMs: 45_000 })
}

export async function subagentViewerGrant(sandbox: Sandbox, lease: SubagentLease, userId: string, mode: 'view' | 'control') {
  if (mode === 'control' && (lease.controlledBy !== userId || lease.controlUntil <= Date.now() / 1000)) throw new Error('Control is not held')
  const exp = Math.floor(Date.now() / 1000) + 120
  const payload = Buffer.from(JSON.stringify({ kind: 'subagent', ...lease, userId, mode, exp })).toString('base64url')
  const key = await sandbox.files.read('/run/mikka-viewer/key', { user: 'root', format: 'bytes' })
  const signature = createHmac('sha256', key).update(payload).digest('base64url')
  return { url: `wss://${sandbox.getHost(6081)}/subagents/${lease.subagentId}?token=${payload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() }
}

/** Only reviewed, fixed actions reach the private browser RPC. No request
 * content enters argv, shell source, access logs or the model's environment. */
export async function subagentBrowserAction(sandbox: Sandbox, lease: SubagentLease, request: { action: 'navigate' | 'snapshot' | 'click' | 'type'; url?: string; ref?: number; targetDigest?: string; text?: string }) {
  validSubagent(lease.subagentId); validSubagent(lease.botId); validSubagent(lease.workspaceId)
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(lease.ownerId) || !Number.isSafeInteger(lease.policyVersion) || lease.policyVersion < 0) throw new Error('Invalid browser lease')
  const requestId = randomUUID(), dir = `/home/user/.mikka/subagents/${lease.subagentId}`
  await sandbox.files.write(`${dir}/request-${requestId}.json`, JSON.stringify(request), { user: 'user' })
  try {
    const result = await sandbox.commands.run(`/usr/bin/python3 /opt/mikka/computer/subagent-command.py ${lease.subagentId} ${requestId} ${lease.botId} ${lease.ownerId} ${lease.workspaceId} ${lease.policyVersion}`, { user: 'user', timeoutMs: 0 })
    return JSON.parse(result.stdout)
  } finally { await sandbox.commands.run(`rm -f ${dir}/request-${requestId}.json`, { user: 'user', timeoutMs: 10_000 }).catch(() => undefined) }
}

export async function stopSubagentBrowser(sandbox: Sandbox, id: string) {
  validSubagent(id)
  const requestId = randomUUID(), dir = `/home/user/.mikka/subagents/${id}`
  // A worker may fail before creating a browser, or lose the response after
  // closing one. Both cases are already stopped and are safe to retry.
  const status = (await sandbox.commands.run(`if [ ! -d ${dir} ]; then printf stopped; elif flock -n ${dir}/launch.lock true; then printf stopped; else printf running; fi`, { user: 'user', timeoutMs: 10_000 })).stdout.trim()
  if (status === 'stopped') return
  if (status !== 'running') throw new Error('Browser state unavailable')
  await sandbox.files.write(`${dir}/request-${requestId}.json`, JSON.stringify({ action: 'close' }), { user: 'user' })
  try {
    await sandbox.commands.run(`if [ -S ${dir}/browser.sock ]; then flock -x /run/mikka-subagent/${id}.lock /usr/local/bin/node /opt/mikka/computer/subagent-rpc.mjs ${id} ${requestId} || flock -n ${dir}/launch.lock true; fi; flock -w 30 ${dir}/launch.lock true`, { user: 'user', timeoutMs: 45_000 })
  } finally { await sandbox.commands.run(`rm -f ${dir}/request-${requestId}.json`, { user: 'user', timeoutMs: 10_000 }).catch(() => undefined) }
}

export async function installComputerRuntime(sandbox: Sandbox) {
  // Created per instance, never baked into a shared template.
  await sandbox.commands.run("if getent group mikka-runner >/dev/null; then install -d -m 710 -o root -g mikka-runner /run/mikka-viewer; else install -d -m 700 /run/mikka-viewer; fi; umask 077; head -c 32 /dev/urandom > /run/mikka-viewer/key", { user: 'root' })
  for (const name of ['start-desktop.sh', 'viewer-gateway.py', 'lease-driver.py']) {
    const content = await readFile(join(process.cwd(), 'scripts/e2b', name), 'utf8')
    await sandbox.files.write(`/opt/mikka/computer/${name}`, content, { user: 'root' })
  }
  await ensureCookieRuntime(sandbox)
  await sandbox.commands.run('chmod 0755 /opt/mikka/computer/lease-driver.py', { user: 'root', timeoutMs: 10_000 })
  await sandbox.commands.run('flock -n /run/mikka-viewer/gateway.lock /usr/bin/python3 /opt/mikka/computer/viewer-gateway.py', { user: 'root', background: true, timeoutMs: 0 })
  await sandbox.commands.run('for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6080/vnc)" = 401 ] && exit 0; sleep .2; done; exit 1', { user: 'root', timeoutMs: 10_000 })
}

/** Start the container service for a dedicated trusted hosted worker. The
 * task account never receives its socket or E2B control-plane credentials. */
export async function ensureContainerRuntime(sandbox: Sandbox) {
  const script = await readFile(join(process.cwd(), 'scripts/e2b/start-container-runtime.sh'), 'utf8')
  await sandbox.files.write('/opt/mikka/computer/start-container-runtime.sh', script, { user: 'root' })
  await sandbox.commands.run('bash /opt/mikka/computer/start-container-runtime.sh', { user: 'root', background: true, timeoutMs: 0 })
  await sandbox.commands.run('for i in $(seq 1 60); do docker --host=unix:///run/mikka-container/docker.sock info >/dev/null 2>&1 && exit 0; sleep .5; done; exit 1', { user: 'root', timeoutMs: 35_000 })
}

/** Provision only the fixed reviewed runtime image, never a model-supplied image. */
export async function ensureHostedRunnerImage(sandbox: Sandbox) {
  await ensureContainerRuntime(sandbox)
  const image = HOSTED_NATIVE_IMAGE
  await sandbox.commands.run(`docker --host=unix:///run/mikka-container/docker.sock image inspect ${image} >/dev/null 2>&1 || docker --host=unix:///run/mikka-container/docker.sock pull ${image} >/dev/null`, { user: 'root', timeoutMs: 300_000 })
}

export async function startDesktop(sandbox: Sandbox, display: number) {
  if (!Number.isInteger(display) || display < 1 || display > 999) throw new Error('Invalid display')
  await ensureCookieRuntime(sandbox)
  await sandbox.files.write('/opt/mikka/computer/start-desktop.sh', await readFile(join(process.cwd(), 'scripts/e2b/start-desktop.sh'), 'utf8'), { user: 'root' })
  await sandbox.commands.run(`bash /opt/mikka/computer/start-desktop.sh ${display}`, { user: 'user', background: true, timeoutMs: 0 })
  await sandbox.commands.run(`for i in $(seq 1 120); do DISPLAY=:${display} xdpyinfo >/dev/null 2>&1 && test -S /home/user/.mikka/vnc/${display}-view.sock && test -S /home/user/.mikka/vnc/${display}-control.sock && DISPLAY=:${display} xdotool search --onlyvisible --class chromium >/dev/null 2>&1 && exit 0; sleep .25; done; exit 1`, { user: 'user', timeoutMs: 35_000 })
}

export async function syncDesktopLease(sandbox: Sandbox, lease: DesktopLease) {
  // Atomic rename: readers never observe a truncated revocation/control state.
  if (!Number.isInteger(lease.display) || lease.display < 1 || lease.display > 999) throw new Error('Invalid display')
  // Existing sandboxes may have been provisioned by an older deployment.
  // Install the current guard before publishing a policy-bearing lease.
  const guard = await readFile(join(process.cwd(), 'scripts/e2b/lease-driver.py'), 'utf8')
  await sandbox.files.write('/opt/mikka/computer/lease-driver.py', guard, { user: 'root' })
  await sandbox.commands.run('chmod 0755 /opt/mikka/computer/lease-driver.py', { user: 'root', timeoutMs: 10_000 })
  const path = `/run/mikka-viewer/${lease.display}`
  await sandbox.files.write(`${path}.next`, JSON.stringify(lease), { user: 'root' })
  // A shared lock is held for the whole CUA driver process. Takeover waits
  // until it exits, then publishes the new lease before granting control.
  await sandbox.commands.run(`touch ${path}.lock; if getent group mikka-runner >/dev/null; then chown root:mikka-runner ${path}.lock ${path}.next; chmod 660 ${path}.lock; chmod 640 ${path}.next; else chmod 600 ${path}.lock ${path}.next; fi; flock -x ${path}.lock mv ${path}.next ${path}.json`, { user: 'root', timeoutMs: 45_000 })
}

export async function viewerGrant(sandbox: Sandbox, lease: DesktopLease, userId: string, mode: 'view' | 'control') {
  if (mode === 'control' && (lease.controlledBy !== userId || lease.controlUntil <= Date.now() / 1000)) throw new Error('Control is not held')
  const exp = Math.floor(Date.now() / 1000) + 120
  const payload = Buffer.from(JSON.stringify({ ...lease, userId, mode, exp })).toString('base64url')
  const key = await sandbox.files.read('/run/mikka-viewer/key', { user: 'root', format: 'bytes' })
  const signature = createHmac('sha256', key).update(payload).digest('base64url')
  return { url: `wss://${sandbox.getHost(6080)}/vnc?token=${payload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() }
}
