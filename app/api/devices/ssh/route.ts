import { NextResponse } from 'next/server'
import { and, desc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import { getTranslations } from 'next-intl/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { deviceTokens, devices } from '@/lib/db/schema'
import { hashDeviceToken, newDeviceToken } from '@/lib/device-link'
import { firstLine, parseSshTarget, rsync, sshRun } from '@/lib/ssh'
import { routing } from '@/i18n/routing'

export const dynamic = 'force-dynamic'
/** ssh, rsync and a remote install; long, but bounded. */
export const maxDuration = 800

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
  // The origin goes into a remote shell command, so it must be a plain URL.
  const origin = new URL(request.url).origin
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(origin)) {
    return NextResponse.json({ error: 'Invalid server origin.' }, { status: 400 })
  }
  const repoRoot = process.cwd()
  const userId = session.user.id
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
        await sshRun(target, 'mkdir -p ~/.orvilo/data')
        const copy = await rsync(`${repoRoot}/packages`, target, '~/.orvilo/packages', ['--exclude', 'node_modules', '--exclude', '.turbo'])
        if (copy.code !== 0) {
          send({ step: 'install', state: 'failed', detail: firstLine(copy.stderr) || t('rsyncExitCode', { code: copy.code }) })
          return
        }
        await rsync(`${repoRoot}/pnpm-workspace.yaml`, target, '~/.orvilo/pnpm-workspace.yaml')
        await sshRun(target, [
          "cat > ~/.orvilo/package.json <<'ORVILO_EOF'",
          JSON.stringify({ name: 'orvilo-daemon-host', private: true, type: 'module' }, null, 2),
          'ORVILO_EOF',
        ].join('\n'))
        const install = await sshRun(target, 'cd ~/.orvilo && pnpm install --silent', 900_000)
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
          "cat > ~/.orvilo/data/device.json <<'ORVILO_EOF'",
          JSON.stringify({ credential: token }),
          'ORVILO_EOF',
          'chmod 600 ~/.orvilo/data/device.json',
        ].join('\n'))
        const startedAt = new Date()
        const start = await sshRun(target, `cd ~/.orvilo && nohup ./node_modules/.bin/tsx packages/daemon/bin/orvilo.ts daemon --server '${origin}' --data-dir ~/.orvilo/data > ~/.orvilo/daemon.log 2>&1 < /dev/null & echo started`)
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
            const log = await sshRun(target, 'tail -n 5 ~/.orvilo/daemon.log')
            send({ step: 'connect', state: 'failed', detail: firstLine(log.stdout) || t('heartbeatTimeout') })
            return
          }
          await new Promise(resolve => { setTimeout(resolve, 2_000) })
        }
      } catch (error) {
        send({ step: 'connect', state: 'failed', detail: error instanceof Error ? error.message : t('connectionError') })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  })
}
