import 'server-only'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Sandbox } from 'e2b'

const lifetime = 15 * 60_000
export type DesktopLease = { botId: string; ownerId: string; display: number; epoch: number; controlledBy: string | null; controlUntil: number }
const options = () => {
  if (!process.env.E2B_API_KEY) throw new Error('Cloud computer is not configured')
  return { apiKey: process.env.E2B_API_KEY, timeoutMs: lifetime }
}

export async function connectComputer(id: string) {
  return Sandbox.connect(id, options())
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
  await sandbox.commands.run("install -d -m 700 /run/mikka-viewer; umask 077; head -c 32 /dev/urandom > /run/mikka-viewer/key", { user: 'root' })
  for (const name of ['start-desktop.sh', 'viewer-gateway.py']) {
    const content = await readFile(join(process.cwd(), 'scripts/e2b', name), 'utf8')
    await sandbox.files.write(`/opt/mikka/computer/${name}`, content, { user: 'root' })
  }
  await sandbox.commands.run('flock -n /run/mikka-viewer/gateway.lock /usr/bin/python3 /opt/mikka/computer/viewer-gateway.py', { user: 'root', background: true, timeoutMs: 0 })
  await sandbox.commands.run('for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6080/vnc)" = 401 ] && exit 0; sleep .2; done; exit 1', { user: 'root', timeoutMs: 10_000 })
}

export async function startDesktop(sandbox: Sandbox, display: number) {
  if (!Number.isInteger(display) || display < 1 || display > 999) throw new Error('Invalid display')
  await sandbox.commands.run(`bash /opt/mikka/computer/start-desktop.sh ${display}`, { user: 'user', background: true, timeoutMs: 0 })
}

export async function syncDesktopLease(sandbox: Sandbox, lease: DesktopLease) {
  // Atomic rename: readers never observe a truncated revocation/control state.
  const path = `/run/mikka-viewer/${lease.display}`
  await sandbox.files.write(`${path}.next`, JSON.stringify(lease), { user: 'root' })
  await sandbox.commands.run(`mv ${path}.next ${path}.json`, { user: 'root', timeoutMs: 10_000 })
}

export async function viewerGrant(sandbox: Sandbox, lease: DesktopLease, userId: string, mode: 'view' | 'control') {
  if (mode === 'control' && (lease.controlledBy !== userId || lease.controlUntil <= Date.now() / 1000)) throw new Error('Control is not held')
  const exp = Math.floor(Date.now() / 1000) + 120
  const payload = Buffer.from(JSON.stringify({ ...lease, userId, mode, exp })).toString('base64url')
  const key = await sandbox.files.read('/run/mikka-viewer/key', { user: 'root', format: 'bytes' })
  const signature = createHmac('sha256', key).update(payload).digest('base64url')
  return { url: `wss://${sandbox.getHost(6080)}/vnc?token=${payload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() }
}
