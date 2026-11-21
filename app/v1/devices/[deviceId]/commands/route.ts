import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from '@/lib/server-runtime/server'
import { COMMANDS_DAEMON_LATEST_PARAM, COMMANDS_MAX_SKIP, COMMANDS_MAX_SKIP_DEVICE_COMMANDS, COMMANDS_SKIP_DEVICE_COMMANDS_PARAM, COMMANDS_SKIP_PARAM, ACTIVE_TURN_STEER_HEADER, MAILBOX_NOTICE_HEADER } from '@mikka/protocol/device'
import { daemonVersions } from '@/lib/daemon-release'
import { authenticateDevice, deviceMayHaveWork, deviceWork, ownsDevice } from '@/lib/device-link'
import { noteLogOutcome, withRequestLog } from '@/lib/request-log'
import { WORKSPACE_REQUEST_HEADER } from '@mikka/protocol/coding-workspace'
import { WORKSPACE_DIFF_REQUEST_HEADER } from '@mikka/protocol/coding-workspace-review'
import { WORKSPACE_GIT_REQUEST_HEADER } from '@mikka/protocol/coding-workspace-git'
import { pendingWorkspaceReads } from '@/lib/coding-workspace/requests'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { z } from 'zod'
import { MCP_CHECK_HEADER } from '@mikka/protocol/mcp-check'


/**
 * `GET /v1/devices/:deviceId/commands`: messages people sent this device's
 * running agents, stops they asked for, and runs queued for it. The daemon
 * reads it when its device session signals work, and once after the session
 * opens (decision 2026-11-17-2215); it answers at once and never waits: there
 * is no long poll. A daemon that sends `daemonLatest` also gets the daemon
 * releases and its oldest pending device command (an update a person asked for).
 */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  const device = await ownsDevice(deviceId, caller.userId)
  if (!device) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const search = new URL(request.url).searchParams
  const list = (name: string, max: number) => (search.get(name) ?? '').split(',').filter(Boolean).slice(0, max)
  const skip = list(COMMANDS_SKIP_PARAM, COMMANDS_MAX_SKIP)
  const knownRelease = search.get(COMMANDS_DAEMON_LATEST_PARAM)
  // A device with scheduling off gets no work (as GET .../runs).
  const options = { ...(request.headers.get(ACTIVE_TURN_STEER_HEADER) === '1' ? { activeTurnSteer: true } : {}), mailboxNotices: request.headers.get(MAILBOX_NOTICE_HEADER) === '1', queued: device.enabled }
  // The cheap check also refuses a revoked credential; the full read hands over work.
  const check = await deviceMayHaveWork(deviceId, skip, knownRelease ? { ...options, skipDeviceCommands: list(COMMANDS_SKIP_DEVICE_COMMANDS_PARAM, COMMANDS_MAX_SKIP_DEVICE_COMMANDS) } : options)
  const { commands, queuedRuns: queued } = check.work ? await deviceWork(deviceId, skip, options) : { commands: [], queuedRuns: [] }
  const workspaceRequests = request.headers.get(WORKSPACE_REQUEST_HEADER) === '1'
    ? await pendingWorkspaceReads(pool, workspacePool, caller, deviceId, list('skipWorkspaceRequests', 8).filter(id => z.uuid().safeParse(id).success),
      { diff: request.headers.get(WORKSPACE_DIFF_REQUEST_HEADER) === '1',
        git: request.headers.get(WORKSPACE_GIT_REQUEST_HEADER) === '1' }) : []
  const releases = knownRelease ? await daemonVersions() : undefined
  const mcpChecks = request.headers.get(MCP_CHECK_HEADER) === '1'
    ? await (await import('@/lib/plugins/runtime')).mcpDeviceChecks.pending(caller.userId, deviceId) : []
  noteLogOutcome(commands.length > 0 || queued.length > 0 || workspaceRequests.length > 0 || mcpChecks.length > 0 || check.deviceCommand !== null ? 'work' : 'empty')
  return NextResponse.json({
    commands,
    ...(workspaceRequests.length ? { workspaceRequests } : {}),
    ...(queued.length > 0 ? { queuedRuns: queued } : {}),
    ...(check.deviceCommand ? { deviceCommands: [check.deviceCommand] } : {}),
    ...(mcpChecks.length ? { mcpChecks } : {}),
    ...(releases ? { daemonVersions: releases } : {}),
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export const GET = withRequestLog('/v1/devices/[deviceId]/commands', withDeviceRoute(handleGET))
