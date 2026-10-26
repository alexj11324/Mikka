import type {Pool} from 'pg'
/** Capture only a real workspace established by this authenticated human input.
 * A linked issue is unambiguous; an unlinked DM needs exactly one membership.
 * Background/legacy event scope is never inferred with this helper. */
export async function telegramCoordinatorWorkspace(workspace:Pick<Pool,'query'>,ownerId:string,issueId:string|null){
 if(issueId){
  const links=await workspace.query('SELECT "workspaceId" FROM mikka_team_issues WHERE "issueId"=$1',[issueId])
  if(links.rows.length){
   const id=links.rows[0].workspaceId
   return (await workspace.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status=\'active\'',[id,ownerId])).rowCount?id as string:null
  }
 }
 const rows=await workspace.query('SELECT "workspaceId" FROM mikka_workspace_members WHERE "userId"=$1 AND status=\'active\' ORDER BY "workspaceId" LIMIT 2',[ownerId])
 return rows.rows.length===1?rows.rows[0].workspaceId as string:null
}
