import { NextResponse } from 'next/server';
import { auth } from '@/lib/api-auth';
import { factoryLifecycleEnabled, factoryRuntimeForBot } from '@/lib/factory/runtime';
import { handleFactoryQuestionList } from '@/lib/factory/questions/ask-user';
export const dynamic = 'force-dynamic';
/** GET /api/factory/questions[?taskId=|?runId=] — pending questions in AskUserQuestion shape. */
export async function GET(request: Request) {
  if (!factoryLifecycleEnabled()) return NextResponse.json({error:'factoryLifecycleUnavailable'},{status:404});
  if (request.headers.get('authorization')) return NextResponse.json({error:'authRequired'},{status:401});
  const session=await auth.api.getSession({headers:request.headers});
  if (!session?.user) return NextResponse.json({error:'authRequired'},{status:401});
  // Question reads are scoped by user only; the bot runtime choice does not filter them.
  const result=await handleFactoryQuestionList(factoryRuntimeForBot(null).questions,{actor:{userId:session.user.id},authorization:null,method:'GET',url:request.url});
  return NextResponse.json(result.body,{status:result.status,headers:{'Cache-Control':'private, no-store'}});
}
