import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http';
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/api-auth';
import { pool } from '@/lib/db';
import { factoryLifecycleEnabled, factoryRuntimeForBot } from '@/lib/factory/runtime';
import { handleFactoryQuestion } from '@/lib/factory/questions/http';
export const dynamic = 'force-dynamic';
async function handle(request: Request,{params}:{params:Promise<{questionId:string}>}) {
  if (!factoryLifecycleEnabled()) return NextResponse.json({error:'factoryLifecycleUnavailable'},{status:404});
  const sessionHeaders=request.headers.has('authorization')?humanSessionHeaders(request):request.headers;
  if (!sessionHeaders) return NextResponse.json({error:'authRequired'},{status:401});
  const session=await auth.api.getSession({headers:sessionHeaders,query:{disableCookieCache:true}});
  if (!session?.user || !session.session?.id) return NextResponse.json({error:'authRequired'},{status:401});
  const id=z.uuid().safeParse((await params).questionId);
  if (!id.success) return NextResponse.json({error:'factoryInvalid'},{status:422});
  const humanSessionId = session.session.id;
  return factoryHumanWorkspaceResponse(session?.user, async () => {
    const questionId=id.data.toLowerCase();
    const {rows:[identity]}=await pool.query('SELECT t."botId" FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId" WHERE q.id=$1 AND q."userId"=$2 AND t."userId"=$2',[questionId,session.user.id]);
    if (!identity) return NextResponse.json({error:'factoryNotFound'},{status:404});
    const result=await handleFactoryQuestion(factoryRuntimeForBot(identity.botId).questions,{
      actor:{userId:session.user.id,sessionId:humanSessionId},authorization:null,method:request.method,
      questionId,origin:request.headers.get('origin'),url:request.url,
      body:request.method==='POST'?await request.json().catch(()=>null):undefined,
    });
    return NextResponse.json(result.body,{status:result.status,headers:{'Cache-Control':'private, no-store'}});
  });

}
export const GET=handle;
export const POST=handle;
