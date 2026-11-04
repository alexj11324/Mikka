import { NextResponse } from 'next/server'
import { z } from 'zod'
import { and,eq } from 'drizzle-orm'
import { auth,apiWorkspaceAllowed } from '@/lib/api-auth'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { updateOwnedBot } from '@/lib/bot-update'
import { ActionFailureError } from '@/lib/action-error'

export const dynamic='force-dynamic'
const patch=z.object({name:z.string().optional(),color:z.string().optional(),shape:z.string().optional(),publicRole:z.string().max(2000).optional()}).strict()
const response=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}})

async function handle(request:Request,{params}:{params:Promise<{botId:string}>}) {
  const session=await auth.api.getSession({headers:request.headers,query:{disableCookieCache:true}})
  if (!session) return response({error:'authRequired'},401)
  const {botId}=await params
  if (!z.uuid().safeParse(botId).success) return response({error:'botNotFound'},404)
  if (request.method!=='GET' && request.headers.get('origin')!==new URL(request.url).origin) return response({error:'invalidOrigin'},403)
  const {workspace}=await loadWorkspaceContext(undefined,session.user)
  if (!apiWorkspaceAllowed(session,workspace.id)) return response({error:'botNotFound'},404)
  if (request.method==='GET') {
    const [bot]=await db.select({id:bots.id,name:bots.name,color:bots.color,shape:bots.shape,publicRole:bots.publicRole}).from(bots).where(and(eq(bots.id,botId),eq(bots.ownerId,session.user.id),eq(bots.workspaceId,workspace.id))).limit(1)
    return bot ? response(bot) : response({error:'botNotFound'},404)
  }
  const body=patch.safeParse(await request.json().catch(()=>null))
  if (!body.success) return response({error:'validationGeneric'},400)
  try {return response(await updateOwnedBot({ownerId:session.user.id,workspaceId:workspace.id},{botId,...body.data}))}
  catch(error) {if (error instanceof ActionFailureError) return response({error:error.code},error.code==='botNotFound'?404:400);throw error}
}
export const GET=handle
export const PATCH=handle
