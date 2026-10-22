import { NextResponse } from 'next/server'
import { and, desc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import { getTranslations } from 'next-intl/server'
import { auth, authBaseURL } from '@/lib/auth'
import { BASE_PATH } from '@/lib/base-path'
import { db } from '@/lib/db'
import { deviceTokens, devices } from '@/lib/db/schema'
import { hashDeviceToken, newDeviceToken } from '@/lib/device-link'
import { firstLine, listSshHosts, parseSshTarget, rsync, sshRun } from '@/lib/ssh'
import { routing } from '@/i18n/routing'

export const dynamic = 'force-dynamic'
/** ssh, rsync and a remote install; 300s is the Hobby plan's ceiling. */
export const maxDuration = 300

/** One long install per account at a time; the next request gets a 429. */
const activeConnects = new Map<string, number>()

const bodySchema = z.object({
  host: z.string().trim().min(1).max(255),
  user: z.string().trim().max(64).default(''),
  name: z.string().trim().max(60).default(''),
  locale: z.enum(routing.locales).default(routing.defaultLocale),
})

interface StepEvent {
  step: 'login' | 'check' | 'install' | 'start' | 'connect'
  state: 'active' | 'done' | 'failed'
  detail?: string
  deviceId?: string
}

/**
 * The server's SSH keys must only reach machines an administrator configured,
 * not any host an authenticated user types into the form. `~/.ssh/config`
 * hosts are the normal path; `MIKKA_SSH_HOSTS` is the explicit override for
 * deployments that keep config elsewhere. The manual token flow stays
 * available for arbitrary machines.
 */
async function isAllowedSshHost(hostname: string): Promise<boolean> {
  const allowlist = (process.env.MIKKA_SSH_HOSTS ?? process.env.ORVILO_SSH_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (allowlist.includes(hostname)) return true
  const hosts = await listSshHosts()
  return hosts.some((host) => host.alias === hostname || host.hostName === hostname)
}

/**
 * Connects a remote machine over SSH: log in, check what it has, copy the
 * daemon there, install it, start it, and wait for the device to appear.
 * Every step is streamed as one JSON line so the dialog can show progress the
 * way a terminal installer does.
 *
 * Runs from the server machine, so it uses that machine's SSH keys. On a
 * deployment without `ssh` (Vercel) it fails at the first step; the manual
 * token flow is the fallback there.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid host.' }, { status: 400 })
  const { host, user, name, locale } = parsed.data
  const t = await getTranslations({ locale, namespace: 'Devices.connect' })
  const target = parseSshTarget(host, user)
  if (!target) return NextResponse.json({ error: 'Invalid host.' }, { status: 400 })
  const requestedHost = host.split(':')[0]
  if (!(await isAllowedSshHost(requestedHost))) {
    return NextResponse.json({ error: 'Host is not in the server SSH allowlist.' }, { status: 403 })
  }
  // The origin goes into a remote shell command, so it must be a configured,
  // plain URL. Never fall back to the request Host header.
  const origin = authBaseURL
  if (!origin) return NextResponse.json({ error: 'Server URL is not configured.' }, { status: 500 })
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(origin)) {
    return NextResponse.json({ error: 'Invalid server origin.' }, { status: 400 })
  }
  const repoRoot = process.cwd()
  const userId = session.user.id
  const active = activeConnects.get(userId) ?? 0
  if (active >= 1) return NextResponse.json({ error: 'Another connection is already running.' }, { status: 429 })
  activeConnects.set(userId, active + 1)
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StepEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      try {
        send({ step: 'login', state: 'active' })
        const login = await sshRun(target, 'echo ok')
        if (login.code !== 0) {
          send({ step: 'login', state: 'failed', detail: firstLine(login.stderr) || t('sshExitCode', { code: login.code }) })
          return
        }
        send({ step: 'login', state: 'done', detail: target })

        send({ step: 'check', state: 'active' })
        const check = await sshRun(target, 'uname -s -m; command -v node || echo NO_NODE; command -v pnpm || echo NO_PNPM')
        const out = check.stdout
        if (out.includes('NO_NODE') || out.includes('NO_PNPM')) {
          send({
            step: 'check', state: 'failed',
            detail: out.includes('NO_NODE') ? t('noNode') : t('noPnpm'),
          })
          return
        }
        send({ step: 'check', state: 'done', detail: firstLine(out) })

        send({ step: 'install', state: 'active', detail: t('copyDaemon') })
        await sshRun(target, 'mkdir -p ~/.mikka/data')
        const copy = await rsync(`${repoRoot}/packages`, target, '~/.mikka/packages', ['--exclude', 'node_modules', '--exclude', '.turbo'])
        if (copy.code !== 0) {
          send({ step: 'install', state: 'failed', detail: firstLine(copy.stderr) || t('rsyncExitCode', { code: copy.code }) })
          return
        }
        await rsync(`${repoRoot}/pnpm-workspace.yaml`, target, '~/.mikka/pnpm-workspace.yaml')
        await sshRun(target, [
          "cat > ~/.mikka/package.json <<'MIKKA_EOF'",
          JSON.stringify({ name: 'mikka-daemon-host', private: true, type: 'module' }, null, 2),
          'MIKKA_EOF',
        ].join('\n'))
        const install = await sshRun(target, 'cd ~/.mikka && pnpm install --silent', 900_000)
        if (install.code !== 0) {
          send({ step: 'install', state: 'failed', detail: firstLine(install.stderr) || t('installExitCode', { code: install.code }) })
          return
        }
        send({ step: 'install', state: 'done', detail: t('depsInstalled') })

        send({ step: 'start', state: 'active' })
        const token = newDeviceToken()
        await db.insert(deviceTokens).values({
          id: crypto.randomUUID(), userId, name: name || `ssh:${host}`, tokenHash: hashDeviceToken(token),
        })
        await sshRun(target, [
          "cat > ~/.mikka/data/device.json <<'MIKKA_EOF'",
          JSON.stringify({ credential: token }),
          'MIKKA_EOF',
          'chmod 600 ~/.mikka/data/device.json',
        ].join('\n'))
        const startedAt = new Date()
        const start = await sshRun(target, `cd ~/.mikka && nohup ./node_modules/.bin/tsx packages/daemon/bin/mikka.ts daemon --server '${origin}${BASE_PATH}' --data-dir ~/.mikka/data > ~/.mikka/daemon.log 2>&1 < /dev/null & echo started`)
        if (start.code !== 0) {
          send({ step: 'start', state: 'failed', detail: firstLine(start.stderr) || t('startExitCode', { code: start.code }) })
          return
        }
        send({ step: 'start', state: 'done', detail: t('daemonRunning') })

        send({ step: 'connect', state: 'active' })
        const deadline = Date.now() + 45_000
        for (;;) {
          const [device] = await db.select({ id: devices.id, name: devices.name }).from(devices)
            .where(and(eq(devices.ownerId, userId), gt(devices.lastSeenAt, startedAt)))
            .orderBy(desc(devices.lastSeenAt)).limit(1)
          if (device) {
            send({ step: 'connect', state: 'done', detail: device.name, deviceId: device.id })
            return
          }
          if (Date.now() > deadline) {
            const log = await sshRun(target, 'tail -n 5 ~/.mikka/daemon.log')
            send({ step: 'connect', state: 'failed', detail: firstLine(log.stdout) || t('heartbeatTimeout') })
            return
          }
          await new Promise(resolve => { setTimeout(resolve, 2_000) })
        }
      } catch (error) {
        send({ step: 'connect', state: 'failed', detail: error instanceof Error ? error.message : t('connectionError') })
      } finally {
        const running = activeConnects.get(userId) ?? 1
        if (running <= 1) activeConnects.delete(userId)
        else activeConnects.set(userId, running - 1)
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}
