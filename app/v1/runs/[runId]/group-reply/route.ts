import { NextResponse } from 'next/server'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'
import { workspaceDb } from '@/lib/workspace-db'
import { withGroupWorkerAuthority } from '@/lib/group-worker-authority'
import { completeReviewWork } from '@/lib/group-review-runtime'
import { groupMailboxAdapter } from '@/lib/group-mailbox-runtime'
import { ReviewFailure } from '@/lib/group-review-access'

/** Device auth only. Browser sessions and browser-supplied author fields do not
 * authorize Agent authorship. This route cannot serve private repository runs.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { runId } = await params
  if (!z.uuid().safeParse(runId).success) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const owned = await pool.query(`SELECT r."deviceId" FROM agent_runs r JOIN devices d ON d.id=r."deviceId"
    WHERE r.id=$1 AND r."userId"=$2 AND d."ownerId"=$2 AND r.kind='group_review'`, [runId, caller.userId])
  if (!owned.rowCount) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  try {
    const input=await request.json().catch(() => null)
    const result = await withGroupWorkerAuthority(workspaceDb.$client,caller,owned.rows[0].deviceId,directory => completeReviewWork(pool, directory, groupMailboxAdapter(pool), runId, input))
    return NextResponse.json(result, { status: result.status === 'conflict' ? 409 : result.status === 'cancelled' ? 403 : 200, headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof ReviewFailure) return NextResponse.json({ error: error.code }, { status: error.status })
    throw error
  }
}
