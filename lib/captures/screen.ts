import 'server-only'
import type { Sandbox } from 'e2b'
import type { PoolClient } from 'pg'
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
export interface ScreenCaller { userId: string; workspaceId: string; deviceId: string; tokenId: string }

const LIVE = ['preparing', 'running', 'waiting_input', 'finishing']
/** A recording's slot outlives its limit by this much before it counts as abandoned. */
const RECORDING_GRACE_MS = 30_000
const DEFAULT_RECORDING_SECONDS = 120
const CAPTURE_FENCE_MS = 30_000

type Target = { owner: CaptureOwner; sandboxId: string; display: number }

const unavailable: CaptureError = { error: 'unavailable', message: 'The cloud computer is unavailable; no automatic retry.' }
const uncertain: CaptureError = { error: 'unavailable', message: 'Capture outcome is unknown; do not automatically retry.' }

export class ScreenCaptures {
  constructor(private runtime: Runtime = provider, private now = () => Date.now(), private fenceMs = CAPTURE_FENCE_MS) {}

  /** The run's Bot desktop, if this device may capture it now. */
  private async target(caller: ScreenCaller, runId: string, purpose: 'capture' | 'stop', client: PoolClient | typeof pool = pool): Promise<Target | CaptureError> {
    const { rows } = await client.query(`SELECT r."issueId", b."botId",
      CASE WHEN t."runId" IS NULL THEN d.display ELSE 1 END AS display,
      CASE WHEN t."runId" IS NULL THEN d.control ELSE 'agent' END AS control,
      CASE WHEN t."runId" IS NULL THEN d."controlUntil" ELSE NULL END AS "controlUntil",
      CASE WHEN t."runId" IS NULL THEN m."sandboxId" ELSE t."sandboxId" END AS "sandboxId",
      CASE WHEN t."runId" IS NULL THEN m.state ELSE t.state END AS state, p.permission
      FROM agent_runs r
      JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      LEFT JOIN thread_machines t ON t."runId"=b."runId" AND t."workspaceId"=b."workspaceId" AND t."ownerId"=b."ownerId" AND t."botId"=b."botId"
      LEFT JOIN bot_desktops d ON d."botId"=b."botId" AND d."workspaceId"=b."workspaceId" AND d."ownerId"=b."ownerId" AND t."runId" IS NULL
      LEFT JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId" AND t."runId" IS NULL
      LEFT JOIN workspace_computer_policies p ON p."workspaceId"=b."workspaceId"
      WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 AND r."deviceId"=$4
        AND ((t."runId" IS NOT NULL AND t."deviceId"=$4) OR (t."runId" IS NULL AND m."deviceId"=$4 AND d.display IS NOT NULL))
        AND r.status=ANY($5::text[]) AND r."stopRequestedAt" IS NULL`, [runId, caller.userId, caller.workspaceId, caller.deviceId, LIVE])
    const row = rows[0]
    if (!row) return { error: 'not_found', message: 'This thread has no cloud computer.' }
    if (row.permission === 'deny' || !row.sandboxId || !['starting', 'running'].includes(row.state)) return unavailable
    // While the person holds the desktop, what they do on it is not the thread's evidence.
    if (purpose === 'capture' && row.control === 'user' && row.controlUntil && new Date(row.controlUntil).getTime() > this.now())
      return { error: 'conflict', message: 'The person is using this computer; try again after they hand it back.' }
    return { owner: { userId: caller.userId, runId, issueId: row.issueId, botId: row.botId }, sandboxId: row.sandboxId, display: Number(row.display) }
  }

  private async connect(workspaceId: string, sandboxId: string, signal?: AbortSignal): Promise<Sandbox | null> {
    return this.runtime.connectComputer(workspaceId, sandboxId, signal).catch(() => null)
  }

  /** Fence start/shot against workspace revocation, takeover and run end. */
  private async withCaptureFence<T>(caller: ScreenCaller, runId: string, run: (client: PoolClient, signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T | CaptureError> {
    if (callerSignal?.aborted) return uncertain
    const client = await pool.connect()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel: (() => void) | undefined
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '5s'")
      await client.query("SET LOCAL statement_timeout = '8s'")
      // Server-side backstop if the application or network stalls while it
      // owns the transaction; PostgreSQL releases its locks independently.
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '40s'")
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${caller.workspaceId}`])
      const locked = await client.query(`SELECT r.id FROM agent_runs r JOIN devices dev ON dev.id=r."deviceId"
        JOIN device_tokens tok ON tok.id=$5 AND tok."userId"=r."userId" AND tok."boundDeviceId"=r."deviceId"
          AND tok."boundWorkspaceId"=$6 AND tok."revokedAt" IS NULL AND tok."expiresAt">now()
        WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3 AND dev."ownerId"=$2 AND dev.enabled=true
          AND r.status=ANY($4::text[]) AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now()
        FOR NO KEY UPDATE OF r FOR SHARE OF dev,tok`, [runId, caller.userId, caller.deviceId, LIVE, caller.tokenId, caller.workspaceId])
      if (!locked.rowCount) { await client.query('COMMIT'); return { error: 'not_found', message: 'This thread has no live cloud computer lease.' } }
      const deadline = new Promise<never>((_, reject) => {
        cancel = () => { controller.abort(); reject(new Error('capture cancelled')) }
        callerSignal?.addEventListener('abort', cancel, { once: true })
        if (callerSignal?.aborted) cancel()
        else timer = setTimeout(cancel, this.fenceMs)
      })
      const result = await Promise.race([run(client, controller.signal), deadline])
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      if (controller.signal.aborted) return uncertain
      throw error
    } finally { clearTimeout(timer); if (cancel) callerSignal?.removeEventListener('abort', cancel); client.release() }
  }

  async screenshot(caller: ScreenCaller, runId: string, title: string, callerSignal?: AbortSignal): Promise<CaptureView | CaptureError> {
    const result = await this.withCaptureFence<{ target: Target; bytes: Uint8Array } | CaptureError>(caller, runId, async (client, signal) => {
      signal.throwIfAborted()
      const target = await this.target(caller, runId, 'capture', client)
      signal.throwIfAborted()
      if ('error' in target) return target
      const sandbox = await this.connect(caller.workspaceId, target.sandboxId, signal)
      signal.throwIfAborted()
      if (!sandbox) return unavailable
      // Provider errors may carry request URLs or headers; never pass them on.
      const bytes = await this.runtime.captureScreenshot(sandbox, target.display, crypto.randomUUID(), signal).catch(() => null)
      signal.throwIfAborted()
      if (!bytes) return uncertain
      return { target, bytes }
    }, callerSignal)
    return 'error' in result ? result : saveCapture(result.target.owner, { bytes: result.bytes, title, source: 'cloud_computer' })
  }

  async startRecording(caller: ScreenCaller, runId: string, title: string, maxSeconds = DEFAULT_RECORDING_SECONDS, callerSignal?: AbortSignal): Promise<{ recordingId: string; stopsAt: string } | CaptureError> {
    return this.withCaptureFence<{ recordingId: string; stopsAt: string } | CaptureError>(caller, runId, async (client, signal) => {
      signal.throwIfAborted()
      const seconds = Math.min(Math.max(Math.trunc(maxSeconds), 5), RECORDING_MAX_SECONDS)
      const target = await this.target(caller, runId, 'capture', client)
      signal.throwIfAborted()
      if ('error' in target) return target
      const existing = await currentRecording(runId)
      signal.throwIfAborted()
      if (existing) {
        if (!existing.expiresAt || existing.expiresAt.getTime() > this.now()) return { error: 'conflict', message: 'A recording is already going; stop it first.' }
        // Past its limit: ffmpeg has stopped by itself. Keep what it made, then go on.
        await this.finalize(existing, undefined, signal)
        signal.throwIfAborted()
      }
      const sandbox = await this.connect(caller.workspaceId, target.sandboxId, signal)
      signal.throwIfAborted()
      if (!sandbox) return unavailable
      const stopsAt = new Date(this.now() + seconds * 1000)
      const slot = await openRecording(target.owner, { title, display: target.display, stopsAt: new Date(stopsAt.getTime() + RECORDING_GRACE_MS) })
      if (!slot) return { error: 'conflict', message: 'A recording is already going; stop it first.' }
      if (signal.aborted) { await failRecording(slot.id, 'Recording was not started'); return uncertain }
      try {
        await this.runtime.startScreenRecording(sandbox, target.display, slot.id, seconds, signal)
      } catch {
        // Once issued, failure cannot prove that the remote process did not start.
        // Leave the bounded slot for normal end/expiry reconciliation.
        return uncertain
      }
      signal.throwIfAborted()
      return { recordingId: slot.id, stopsAt: stopsAt.toISOString() }
    }, callerSignal)
  }

  async stopRecording(caller: ScreenCaller, runId: string): Promise<CaptureView | CaptureError> {
    const target = await this.target(caller, runId, 'stop')
    if ('error' in target) return target
    const row = await currentRecording(runId)
    if (!row || row.userId !== caller.userId) return { error: 'not_found', message: 'No recording is going for this thread.' }
    return this.finalize(row, { sandboxId: target.sandboxId, workspaceId: caller.workspaceId })
  }

  /** Stops one recording and keeps the file; marks it failed when the machine or the file is gone. */
  private async finalize(row: NonNullable<Awaited<ReturnType<typeof currentRecording>>>, known?: { sandboxId: string; workspaceId: string }, signal?: AbortSignal): Promise<CaptureView | CaptureError> {
    // A durable thread binding always selects its own sandbox, including
    // after end. Missing thread resources must never fall back to the Bot.
    const bound = known ?? (await pool.query(`SELECT CASE WHEN t."runId" IS NULL THEN m."sandboxId" ELSE t."sandboxId" END AS "sandboxId",b."workspaceId" FROM computer_run_bindings b
      LEFT JOIN thread_machines t ON t."runId"=b."runId" AND t."workspaceId"=b."workspaceId" AND t."ownerId"=b."ownerId" AND t."botId"=b."botId"
      LEFT JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId" AND t."runId" IS NULL
      WHERE b."runId"=$1 AND b."ownerId"=$2`, [row.runId, row.userId])).rows[0] as { sandboxId: string | null; workspaceId: string } | undefined
    const machine = bound?.sandboxId
    signal?.throwIfAborted()
    const sandbox = machine && bound && row.display ? await this.connect(bound.workspaceId, machine, signal) : null
    signal?.throwIfAborted()
    const file = sandbox ? await this.runtime.stopScreenRecording(sandbox, row.display!, row.id, signal).catch(() => null) : null
    signal?.throwIfAborted()
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
