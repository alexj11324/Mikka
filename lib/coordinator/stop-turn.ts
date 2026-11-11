import 'server-only'
import { eveClient } from '../eve/client'
import { assertEveScope } from '../eve/scope'

/** Existing native clients use the same eve cancellation as the web client. */
export async function stopChatTurn(userId:string,botId:string):Promise<boolean> {
  const {pool} = await import('../db')
  const row = (await pool.query<{session_id:string;workspace_id:string}>(`SELECT s.session_id,s.workspace_id FROM eve_sessions s JOIN coordinator_sessions c ON c."userId"=s.owner_id AND c."botId"=s.bot_id AND c."leaseHolder"=s.session_id WHERE s.owner_id=$1 AND s.bot_id=$2 AND s.surface='web' ORDER BY s.created_at DESC LIMIT 1`,[userId,botId])).rows[0]
  if (!row) return false
  const scope = await assertEveScope({ownerId:userId,botId,workspaceId:row.workspace_id,surface:'web'})
  await eveClient(scope).sessions.attach(row.session_id).cancel()
  return true
}
