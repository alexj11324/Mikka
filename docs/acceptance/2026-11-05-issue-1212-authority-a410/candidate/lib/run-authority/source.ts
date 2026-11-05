import type { Pool } from 'pg'
import type { RunAuthorityChallenge, RunAuthorityGrant } from '../../packages/daemon/src/agents/run-authority'

type Database = Pick<Pool,'query'>
type Version = { source: string; revision: string }
type Vector = { app: Version; workspace: Version }
export interface CompleteRunAuthority {
  live: boolean
  /** A conservative remaining duration, including every relevant natural
   * expiry, measured no earlier than this complete reader's invocation. */
  validForMs: number
}

function active(signal: AbortSignal) {
  if (signal.aborted) throw new Error('Run authority unavailable')
}

async function version(database: Database, signal: AbortSignal): Promise<Version> {
  active(signal)
  const {rows} = await database.query<{source:string;revision:string}>(
    'SELECT source::text, revision::text FROM run_authority_version WHERE singleton=true')
  active(signal)
  const row=rows[0]
  if (rows.length!==1 || !row || !/^[0-9a-f-]{36}$/.test(row.source) || !/^(0|[1-9][0-9]*)$/.test(row.revision)) throw new Error('Run authority version unavailable')
  return row
}

async function vector(app: Database, workspace: Database, signal: AbortSignal): Promise<Vector> {
  const [a,w]=await Promise.all([version(app,signal),version(workspace,signal)])
  return {app:a,workspace:w}
}

function equal(a:Vector,b:Vector) {
  return a.app.source===b.app.source && a.app.revision===b.app.revision
    && a.workspace.source===b.workspace.source && a.workspace.revision===b.workspace.revision
}

/** This foundation deliberately has no settled-success cache. Before any
 * cached variant is used, its DB trigger manifest and source placement must
 * be independently established for the complete reader's dependencies.
 * Same-transaction versions bracket the entire existing reader, across both
 * databases. Lost NOTIFY messages cannot manufacture an unchanged version.
 */
export function completeRunAuthoritySource(input: {
  runId: string
  app: Database
  workspace: Database
  read: (signal:AbortSignal)=>Promise<CompleteRunAuthority>
}) {
  return async (challenge: RunAuthorityChallenge, signal: AbortSignal):Promise<RunAuthorityGrant> => {
    if (challenge.runId!==input.runId) throw new Error('Run authority scope unavailable')
    for(let attempt=0;attempt<3;attempt++) {
      active(signal)
      const started=performance.now()
      const before=await vector(input.app,input.workspace,signal)
      const result=await input.read(signal)
      active(signal)
      // A fresh refusal never needs a positive snapshot or a retry.
      if (result.live!==true) return {runId:input.runId,nonce:challenge.nonce,live:false,validForMs:0}
      const after=await vector(input.app,input.workspace,signal)
      if (!equal(before,after)) continue
      const validForMs=Math.min(750,result.validForMs-(performance.now()-started))
      if (!Number.isFinite(validForMs) || validForMs<=0) throw new Error('Run authority expired')
      return {runId:input.runId,nonce:challenge.nonce,live:true,validForMs}
    }
    throw new Error('Run authority changed during snapshot')
  }
}
