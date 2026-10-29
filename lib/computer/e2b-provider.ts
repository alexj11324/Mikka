import 'server-only'
import { createHmac } from 'node:crypto'
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

export async function connectComputer(id: string, signal?: AbortSignal) {
  return Sandbox.connect(id, { ...options(), ...(signal ? { signal, retries: 0 } : {}) })
}

export async function computerState(id: string) {
  const info = await Sandbox.getInfo(id, options())
  return info.state === 'paused' ? 'sleeping' : 'running'
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

export async function installComputerRuntime(sandbox: Sandbox) {
  // Created per instance, never baked into a shared template.
  await sandbox.commands.run("if getent group mikka-runner >/dev/null; then install -d -m 710 -o root -g mikka-runner /run/mikka-viewer; else install -d -m 700 /run/mikka-viewer; fi; umask 077; head -c 32 /dev/urandom > /run/mikka-viewer/key", { user: 'root' })
  for (const name of ['start-desktop.sh', 'viewer-gateway.py', 'lease-driver.py']) {
    const content = await readFile(join(process.cwd(), 'scripts/e2b', name), 'utf8')
    await sandbox.files.write(`/opt/mikka/computer/${name}`, content, { user: 'root' })
  }
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

export async function startDesktop(sandbox: Sandbox, display: number, managedChrome = false) {
  if (!Number.isInteger(display) || display < 1 || display > 999) throw new Error('Invalid display')
  await sandbox.commands.run(`bash /opt/mikka/computer/start-desktop.sh ${display}`, { user: 'user', background: true, timeoutMs: 0, ...(managedChrome ? { envs: { MIKKA_MANAGED_CHROME: '1' } } : {}) })
  await sandbox.commands.run(`for i in $(seq 1 60); do DISPLAY=:${display} xdpyinfo >/dev/null 2>&1 && test -S /home/user/.mikka/vnc/${display}-view.sock && test -S /home/user/.mikka/vnc/${display}-control.sock && exit 0; sleep .25; done; exit 1`, { user: 'user', timeoutMs: 20_000 })
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

// --- Screen captures (lib/captures/screen.ts) ---------------------------------
// ffmpeg's x11grab on the Bot's own display, as the desktop account. The
// noVNC viewer is untouched: captures read the X display, not the viewer.

const CAPTURE_DIR = '/home/user/.mikka/captures'
const CAPTURE_SCRIPT = '/opt/mikka/computer/screen-capture.sh'
const captureId = (id: string) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid capture id'); return id }
const captureDisplay = (display: number) => { if (!Number.isInteger(display) || display < 1 || display > 999) throw new Error('Invalid display'); return display }

async function installCaptureScript(sandbox: Sandbox, signal?: AbortSignal) {
  // Machines provisioned by an older deployment lack it; writing it each time keeps them current.
  // Bundled for the /v1/runs/*/screen route (next.config.mjs).
  const script = await readFile(join(process.cwd(), 'scripts/e2b/screen-capture.sh'), { encoding: 'utf8', signal })
  signal?.throwIfAborted()
  await sandbox.files.write(CAPTURE_SCRIPT, script, { user: 'root', signal })
  signal?.throwIfAborted()
  await sandbox.commands.run(`chmod 0755 ${CAPTURE_SCRIPT}`, { user: 'root', timeoutMs: 10_000, signal })
}

async function takeFile(sandbox: Sandbox, display: number, id: string, name: string, signal?: AbortSignal) {
  try {
    signal?.throwIfAborted()
    return await sandbox.files.read(`${CAPTURE_DIR}/${name}`, { user: 'user', format: 'bytes', signal })
  } finally {
    if (!signal?.aborted) await sandbox.commands.run(`bash ${CAPTURE_SCRIPT} discard ${display} ${id}`, { user: 'user', timeoutMs: 10_000, signal }).catch(() => undefined)
  }
}

export async function captureScreenshot(sandbox: Sandbox, display: number, id: string, signal?: AbortSignal): Promise<Uint8Array> {
  captureDisplay(display); captureId(id)
  await installCaptureScript(sandbox, signal)
  signal?.throwIfAborted()
  await sandbox.commands.run(`bash ${CAPTURE_SCRIPT} shot ${display} ${id}`, { user: 'user', timeoutMs: 20_000, signal })
  signal?.throwIfAborted()
  return takeFile(sandbox, display, id, `${id}.png`, signal)
}

export async function startScreenRecording(sandbox: Sandbox, display: number, id: string, seconds: number, signal?: AbortSignal) {
  captureDisplay(display); captureId(id)
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) throw new Error('Invalid recording length')
  await installCaptureScript(sandbox, signal)
  signal?.throwIfAborted()
  await sandbox.commands.run(`bash ${CAPTURE_SCRIPT} record ${display} ${id} ${seconds}`, { user: 'user', background: true, timeoutMs: 0, signal })
  signal?.throwIfAborted()
  await sandbox.commands.run(`bash ${CAPTURE_SCRIPT} started ${display} ${id}`, { user: 'user', timeoutMs: 10_000, signal })
}

/** Ends the recording and returns the mp4 with its length; the file leaves the machine. */
export async function stopScreenRecording(sandbox: Sandbox, display: number, id: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; durationMs: number }> {
  // The script the recording started with is on the machine; a run ending
  // elsewhere (heartbeat, completion) need not bundle it.
  captureDisplay(display); captureId(id)
  signal?.throwIfAborted()
  const stopped = await sandbox.commands.run(`bash ${CAPTURE_SCRIPT} stop ${display} ${id}`, { user: 'user', timeoutMs: 30_000, signal })
  const seconds = Number.parseFloat(stopped.stdout.trim().split('\n').at(-1) ?? '')
  const bytes = await takeFile(sandbox, display, id, `${id}.mp4`, signal)
  return { bytes, durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0 }
}

/** Stops and deletes a recording without keeping it. */
export async function discardScreenRecording(sandbox: Sandbox, display: number, id: string) {
  captureDisplay(display); captureId(id)
  await sandbox.commands.run(`bash ${CAPTURE_SCRIPT} discard ${display} ${id}`, { user: 'user', timeoutMs: 10_000 })
}
