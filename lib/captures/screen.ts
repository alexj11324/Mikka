import 'server-only'
import type { Sandbox } from 'e2b'
import { RECORDING_MAX_SECONDS, type CaptureView } from '@mikka/protocol/capture'
import { pool } from '@/lib/db'
import * as provider from '@/lib/computer/e2b-provider'
import { currentRecording, failRecording, finishRecording, openRecording, runRecordings, saveCapture, type CaptureError, type CaptureOwner } from './store'

// The cloud computer's capture tools: a screenshot, and a recording started
// and stopped, of the Bot desktop a thread is bound to. The daemon relays the
// thread's call with its device credential; which desktop, machine and owner
// come from the run's binding here, never from the call.

type Runtime = Pick<typeof provider, 'connectComputer' | 'captureScreenshot' | 'startScreenRecording' | 'stopScreenRecording' | 'discardScreenRecording'>
/** The device relaying the call: a cloud worker scoped to one workspace. */
export interface ScreenCaller { userId: string; workspaceId: string; deviceId: string }

const LIVE = ['preparing', 'running', 'waiting_input', 'finishing']
/** A recording's slot outlives its limit by this much before it counts as abandoned. */
const RECORDING_GRACE_MS = 30_000
const DEFAULT_RECORDING_SECONDS = 120

type Target = { owner: CaptureOwner; sandboxId: string; display: number }

const unavailable: CaptureError = { error: 'unavailable', message: 'The cloud computer is unavailable; no automatic retry.' }

export class ScreenCaptures {
  constructor(private runtime: Runtime = provider, private now = () => Date.now()) {}

  /** The run's Bot desktop, if this device may capture it now. */
  private async target(caller: ScreenCaller, runId: string, purpose: 'capture' | 'stop'): Promise<Target | CaptureError> {
    const { rows } = await pool.query(`SELECT r."issueId", b."botId", d.display, d.control, d."controlUntil", m."sandboxId", m.state, p.permission
      FROM agent_runs r
      JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      JOIN bot_desktops d ON d."botId"=b."botId" AND d."workspaceId"=b."workspaceId" AND d."ownerId"=b."ownerId"
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
      LEFT JOIN workspace_computer_policies p ON p."workspaceId"=b."workspaceId"
      WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 AND r."deviceId"=$4 AND m."deviceId"=$4
        AND r.status=ANY($5::text[]) AND r."stopRequestedAt" IS NULL`, [runId, caller.userId, caller.workspaceId, caller.deviceId, LIVE])
    const row = rows[0]
    if (!row) return { error: 'not_found', message: 'This thread has no cloud computer.' }
    if (row.permission === 'deny' || !row.sandboxId || row.state !== 'running') return unavailable
    // While the person holds the desktop, what they do on it is not the thread's evidence.
    if (purpose === 'capture' && row.control === 'user' && row.controlUntil && new Date(row.controlUntil).getTime() > this.now())
      return { error: 'conflict', message: 'The person is using this computer; try again after they hand it back.' }
    return { owner: { userId: caller.userId, runId, issueId: row.issueId, botId: row.botId }, sandboxId: row.sandboxId, display: Number(row.display) }
  }

  private async connect(sandboxId: string): Promise<Sandbox | null> {
    return this.runtime.connectComputer(sandboxId).catch(() => null)
  }

  async screenshot(caller: ScreenCaller, runId: string, title: string): Promise<CaptureView | CaptureError> {
    const target = await this.target(caller, runId, 'capture')
    if ('error' in target) return target
    const sandbox = await this.connect(target.sandboxId)
    if (!sandbox) return unavailable
    // Provider errors may carry request URLs or headers; never pass them on.
    const bytes = await this.runtime.captureScreenshot(sandbox, target.display, crypto.randomUUID()).catch(() => null)
    if (!bytes) return unavailable
    return saveCapture(target.owner, { bytes, title, source: 'cloud_computer' })
  }

  async startRecording(caller: ScreenCaller, runId: string, title: string, maxSeconds = DEFAULT_RECORDING_SECONDS): Promise<{ recordingId: string; stopsAt: string } | CaptureError> {
    const seconds = Math.min(Math.max(Math.trunc(maxSeconds), 5), RECORDING_MAX_SECONDS)
    const target = await this.target(caller, runId, 'capture')
    if ('error' in target) return target
    const existing = await currentRecording(runId)
    if (existing) {
      if (!existing.expiresAt || existing.expiresAt.getTime() > this.now()) return { error: 'conflict', message: 'A recording is already going; stop it first.' }
      // Past its limit: ffmpeg has stopped by itself. Keep what it made, then go on.
      await this.finalize(existing)
    }
    const sandbox = await this.connect(target.sandboxId)
    if (!sandbox) return unavailable
    const stopsAt = new Date(this.now() + seconds * 1000)
    const slot = await openRecording(target.owner, { title, display: target.display, stopsAt: new Date(stopsAt.getTime() + RECORDING_GRACE_MS) })
    if (!slot) return { error: 'conflict', message: 'A recording is already going; stop it first.' }
    try {
      await this.runtime.startScreenRecording(sandbox, target.display, slot.id, seconds)
    } catch {
      await failRecording(slot.id, 'Recording did not start')
      await this.runtime.discardScreenRecording(sandbox, target.display, slot.id).catch(() => undefined)
      return unavailable
    }
    return { recordingId: slot.id, stopsAt: stopsAt.toISOString() }
  }

  async stopRecording(caller: ScreenCaller, runId: string): Promise<CaptureView | CaptureError> {
    const target = await this.target(caller, runId, 'stop')
    if ('error' in target) return target
    const row = await currentRecording(runId)
    if (!row || row.userId !== caller.userId) return { error: 'not_found', message: 'No recording is going for this thread.' }
    return this.finalize(row, target.sandboxId)
  }

  /** Stops one recording and keeps the file; marks it failed when the machine or the file is gone. */
  private async finalize(row: NonNullable<Awaited<ReturnType<typeof currentRecording>>>, sandboxId?: string): Promise<CaptureView | CaptureError> {
    const machine = sandboxId ?? (await pool.query(`SELECT m."sandboxId" FROM computer_run_bindings b
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
      WHERE b."runId"=$1 AND b."ownerId"=$2`, [row.runId, row.userId])).rows[0]?.sandboxId
    const sandbox = machine && row.display ? await this.connect(machine) : null
    const file = sandbox ? await this.runtime.stopScreenRecording(sandbox, row.display!, row.id).catch(() => null) : null
    if (!file) {
      await failRecording(row.id, sandbox ? 'Recording file missing' : 'Cloud computer gone')
      return unavailable
    }
    return finishRecording(row, file)
  }

  /**
   * Called when runs end, however they end: stops what they still record and
   * keeps it, so no recording runs on with nobody to stop it.
   */
  async stopRunRecordings(runIds: readonly string[]) {
    for (const row of await runRecordings(runIds)) await this.finalize(row).catch(() => failRecording(row.id, 'Recording not saved'))
  }
}

export const screenCaptures = new ScreenCaptures()
