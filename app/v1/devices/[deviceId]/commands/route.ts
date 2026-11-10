import { CLIENT_VERSION_HEADER } from '@mikka/protocol/version'
import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { COMMANDS_DAEMON_LATEST_PARAM, COMMANDS_MAX_SKIP, COMMANDS_MAX_SKIP_DEVICE_COMMANDS, COMMANDS_MAX_WAIT_SECONDS, COMMANDS_SKIP_DEVICE_COMMANDS_PARAM, COMMANDS_SKIP_PARAM, MAILBOX_NOTICE_HEADER } from '@mikka/protocol/device'
import { cachedDaemonVersions, daemonVersions, newerDaemonRelease, daemonRequestTooOld } from '@/lib/daemon-release'
import { authenticateDevice, deviceMayHaveWork, deviceUpdateNotice, deviceWork, deviceWorkSubscription, longPollIdleCheck, ownsDevice, sleep, waitSeconds } from '@/lib/device-link'
import { noteLogOutcome, withRequestLog } from '@/lib/request-log'
import { WORKSPACE_REQUEST_HEADER } from '@mikka/protocol/coding-workspace'
import { WORKSPACE_DIFF_REQUEST_HEADER } from '@mikka/protocol/coding-workspace-review'
import { WORKSPACE_GIT_REQUEST_HEADER } from '@mikka/protocol/coding-workspace-git'
import { pendingWorkspaceReads } from '@/lib/coding-workspace/requests'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

/**
 * A daemon on the push socket does not call this route while it is idle; this
 * long poll is the fallback for an old daemon or a gateway that is down. It
 * waits on LISTEN (deviceWorkSubscription): every write that gives the device
 * work, revokes its credential or removes it NOTIFYs, and the poll re-checks
 * only then, plus once at its deadline, which also covers a lost notification
 * (#1212). Without push (no gateway configured, or LISTEN unavailable) it
 * re-checks every longPollIdleCheck.ms (5 s), as before; a revoked credential
 * fails the next check inside the bound in lib/device-revocation.db.test.ts.
 */

/**
 * `GET /v1/devices/:deviceId/commands?wait=<seconds>`: messages people sent
 * this device's running agents, stops they asked for, and runs queued for it
 * (so the daemon claims a new run now, not on its next heartbeat). Long-polls
 * when nothing is pending. A daemon that sends `daemonLatest` also gets the
 * daemon releases and its pending device command (an update a person asked
 * for), and the poll ends as soon as either is news to it.
 */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  const device = await ownsDevice(deviceId, caller.userId)
  if (!device) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const obsolete = daemonRequestTooOld(request.headers.get(CLIENT_VERSION_HEADER), Boolean(caller.scopeDeviceId && caller.scopeWorkspaceId))
  const wait = waitSeconds(request, COMMANDS_MAX_WAIT_SECONDS)
  const search = new URL(request.url).searchParams
  const list = (name: string, max: number) => (search.get(name) ?? '').split(',').filter(Boolean).slice(0, max)
  const skip = list(COMMANDS_SKIP_PARAM, COMMANDS_MAX_SKIP)
  const knownRelease = search.get(COMMANDS_DAEMON_LATEST_PARAM)
  // Read once per poll from the five-minute registry cache; idle checks below only peek at it.
  let releases = knownRelease || obsolete ? await daemonVersions() : undefined
  const deadline = Date.now() + wait * 1000
  // Listen before the first read: a write committed during any read wakes the next wait at once.
  const push = wait > 0 ? await deviceWorkSubscription(deviceId, caller.tokenId) : null
  let timedOut = false
  try {
    while (!request.signal.aborted) {
      push?.reset()
      // A device with scheduling off gets no work (as GET .../runs).
      const options = { mailboxNotices: request.headers.get(MAILBOX_NOTICE_HEADER) === '1', queued: device.enabled }
      // The cheap check also ends the poll for a revoked credential; the full read hands over work.
      const check = obsolete
        ? { work: false, deviceCommand: await deviceUpdateNotice(deviceId) }
        : await deviceMayHaveWork(deviceId, skip, knownRelease ? { ...options, skipDeviceCommands: list(COMMANDS_SKIP_DEVICE_COMMANDS_PARAM, COMMANDS_MAX_SKIP_DEVICE_COMMANDS) } : options)
      const { commands, queuedRuns: queued } = check.work ? await deviceWork(deviceId, skip, options) : { commands: [], queuedRuns: [] }
      const workspaceRequests = !obsolete && request.headers.get(WORKSPACE_REQUEST_HEADER) === '1'
        ? await pendingWorkspaceReads(pool, workspacePool, caller, deviceId, list('skipWorkspaceRequests', 8).filter(id => z.uuid().safeParse(id).success),
          { diff: request.headers.get(WORKSPACE_DIFF_REQUEST_HEADER) === '1',
            git: request.headers.get(WORKSPACE_GIT_REQUEST_HEADER) === '1' }) : []
      if (request.signal.aborted) break
      // Memory only: a release published mid-poll ends it once this instance's cache has it.
      if (knownRelease) releases = cachedDaemonVersions() ?? releases
      const news = check.deviceCommand !== null || (knownRelease !== null && newerDaemonRelease(releases, knownRelease))
      if (commands.length > 0 || queued.length > 0 || workspaceRequests.length > 0 || news || timedOut || Date.now() >= deadline) {
        noteLogOutcome(commands.length > 0 || queued.length > 0 || workspaceRequests.length > 0 || news ? 'work' : 'empty')
        return NextResponse.json({
          commands,
          ...(workspaceRequests.length ? { workspaceRequests } : {}),
          ...(queued.length > 0 ? { queuedRuns: queued } : {}),
          ...(check.deviceCommand ? { deviceCommands: [check.deviceCommand] } : {}),
          ...(releases ? { daemonVersions: releases } : {}),
        })
      }
      // One unlocked read per wait. It does not take the credential lock; a revoked credential fails that read before any message text is loaded (lib/device-revocation.db.test.ts).
      // A deadline timer can finish just before Date.now reaches the same ms.
      // Its next read is final even then; only a notification starts another wait.
      if (push && !push.lost) timedOut = await push.next(Math.max(50, deadline - Date.now()), request.signal) === 'timeout'
      else await sleep(Math.min(longPollIdleCheck.ms, Math.max(50, deadline - Date.now())), request.signal)
    }
  } finally { push?.close() }
  noteLogOutcome('ignored')
  return new NextResponse(null, { status: 204 })
}

export const GET = withRequestLog('/v1/devices/[deviceId]/commands', withDeviceRoute(handleGET))
