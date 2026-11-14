import type { Pool, PoolClient } from 'pg'
import { SandboxSessionGoneError } from 'eve/sandbox/provider'
import type { EveScope } from './scope'
import type { ScratchSnapshot, ScratchMutationResult } from './sandbox-filesystem'

export type ScratchIdentity={sessionId:string;scope:EveScope}
export interface ScratchStore {
  mutate<T>(identity:ScratchIdentity,initial:ScratchSnapshot|undefined,work:(snapshot:ScratchSnapshot)=>Promise<ScratchMutationResult<T>>):Promise<T>
  remove(identity:ScratchIdentity):Promise<void>
}
/** A transaction spans one bounded file/exec operation, never the connection,
 * turn, model generation or idle session. Concurrent replicas serialize here. */
export function scratchStore(pool:Pick<Pool,'connect'|'query'>,authorize:(scope:EveScope,tx:PoolClient)=>Promise<unknown>):ScratchStore {
  return {
    async mutate(identity,initial,work) {
      const client=await pool.connect(),{scope,sessionId}=identity
      try {
        await client.query('BEGIN')
        await client.query("SET LOCAL lock_timeout='15s';SET LOCAL statement_timeout='30s'")
        await authorize(scope,client)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['eve-sandbox',sessionId])])
        const row=(await client.query<{owner_id:string;bot_id:string;workspace_id:string;surface:string;snapshot:ScratchSnapshot}>('SELECT * FROM eve_sandbox_sessions WHERE session_id=$1 FOR UPDATE',[sessionId])).rows[0]
        if(row&&(row.owner_id!==scope.ownerId||row.bot_id!==scope.botId||row.workspace_id!==scope.workspaceId||row.surface!==scope.surface))throw new Error('workspaceAccessDenied')
        if(!row&&!initial)throw new SandboxSessionGoneError('The session scratch files no longer exist.')
        await authorize(scope,client)
        const snapshot = row?.snapshot ?? initial!
        const result = await work(snapshot)
        await authorize(scope,client)
        if (!row) {
          await client.query('INSERT INTO eve_sandbox_sessions(session_id,owner_id,bot_id,workspace_id,surface,snapshot) VALUES($1,$2,$3,$4,$5,$6)',[sessionId,scope.ownerId,scope.botId,scope.workspaceId,scope.surface,result.snapshot ?? snapshot])
        } else if (result.snapshot) {
          await client.query('UPDATE eve_sandbox_sessions SET snapshot=$2,updated_at=clock_timestamp() WHERE session_id=$1',[sessionId,result.snapshot])
        }
        await client.query('COMMIT')
        return result.value
      } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error}
      finally {client.release()}
    },
    async remove({scope,sessionId}) {
      await pool.query('DELETE FROM eve_sandbox_sessions WHERE session_id=$1 AND owner_id=$2 AND bot_id=$3 AND workspace_id=$4 AND surface=$5',[sessionId,scope.ownerId,scope.botId,scope.workspaceId,scope.surface])
    },
  }
}
