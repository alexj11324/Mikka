import type { Pool } from 'pg'
import type { ApprovalRecord, ApprovalStore } from './approval-bridge'

/** A committed executing receipt is never reclaimed after a crash. Personal
 * writes additionally retain their existing operation-ledger invocation gate. */
export function eveApprovalStore(pool:Pick<Pool,'query'>,ownerId:string,botId:string):ApprovalStore {
  const read=async(key:string):Promise<ApprovalRecord|null>=>{
    const row=(await pool.query<ApprovalRecord&{expired:boolean}>(`SELECT call_digest AS "callDigest",plan_digest AS "planDigest",decision,status,output,
      created_at<clock_timestamp()-interval '7 days' AS expired FROM eve_tool_approvals WHERE call_key=$1 AND owner_id=$2 AND bot_id=$3`,[key,ownerId,botId])).rows[0]
    if(row?.expired&&row.status==='prepared')throw new Error('pendingActionUnavailable')
    return row??null
  }
  return {
    read,
    async prepare(key,record) {
      await pool.query(`INSERT INTO eve_tool_approvals(call_key,owner_id,bot_id,call_digest,plan_digest,decision,status,output)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(call_key) DO NOTHING`,[key,ownerId,botId,record.callDigest,record.planDigest,record.decision,record.status,JSON.stringify(record.output??null)])
      const saved=await read(key)
      if(!saved)throw new Error('operationBindingConflict')
      return saved
    },
    async claim(key) {
      const result=await pool.query(`UPDATE eve_tool_approvals SET status='executing' WHERE call_key=$1 AND owner_id=$2 AND bot_id=$3 AND status='prepared' AND created_at>clock_timestamp()-interval '7 days'`,[key,ownerId,botId])
      return result.rowCount===1
    },
    async finish(key,output) {
      await pool.query(`UPDATE eve_tool_approvals SET status='done',output=$4 WHERE call_key=$1 AND owner_id=$2 AND bot_id=$3 AND status='executing'`,[key,ownerId,botId,JSON.stringify(output??null)])
    },
  }
}
