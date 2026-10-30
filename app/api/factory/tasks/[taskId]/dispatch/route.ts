import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { factoryLifecycleEnabled } from '@/lib/factory/runtime';
import { factoryDispatchRecovery } from '@/lib/factory/dispatch-recovery-server';
import { handleFactoryDispatchRecovery } from '@/lib/factory/dispatch-recovery-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request,{params}:{params:Promise<{taskId:string}>}) {
  if (!factoryLifecycleEnabled()) return NextResponse.json({error:'factoryLifecycleUnavailable'},{status:404});
  if (request.headers.get('authorization')) return NextResponse.json({error:'authRequired'},{status:401});
  const session=await auth.api.getSession({headers:request.headers});
  const result=await handleFactoryDispatchRecovery(factoryDispatchRecovery,{userId:session?.user?.id ?? null,taskId:(await params).taskId,action:'status'});
  return NextResponse.json(result.body,{status:result.status,headers:result.headers});
}
