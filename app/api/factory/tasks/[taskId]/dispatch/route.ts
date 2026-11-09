import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http';
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/api-auth';
import { factoryLifecycleEnabled } from '@/lib/factory/runtime';
import { factoryDispatchRecovery } from '@/lib/factory/dispatch-recovery-server';
import { handleFactoryDispatchRecovery } from '@/lib/factory/dispatch-recovery-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request,{params}:{params:Promise<{taskId:string}>}) {
  if (!factoryLifecycleEnabled()) return NextResponse.json({error:'factoryLifecycleUnavailable'},{status:404});
  const sessionHeaders=request.headers.has('authorization')?humanSessionHeaders(request):request.headers;
  if (!sessionHeaders) return NextResponse.json({error:'authRequired'},{status:401});
  const session=await auth.api.getSession({headers:sessionHeaders,query:{disableCookieCache:true}});
  return factoryHumanWorkspaceResponse(session?.user, async () => {
    const result=await handleFactoryDispatchRecovery(factoryDispatchRecovery,{userId:session?.user?.id ?? null,taskId:(await params).taskId,action:'status'});
    return NextResponse.json(result.body,{status:result.status,headers:result.headers});
  });

}
