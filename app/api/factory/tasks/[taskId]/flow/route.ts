import { factoryHumanWorkspaceResponse } from '@/lib/factory/workspace-http';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/api-auth';
import { pool } from '@/lib/db';
import { withRequestLog, noteLogUser } from '@/lib/request-log';
import { factoryBrowserSession } from '@/lib/factory/browser-human';
import { factoryHumanStore, factorySpecApproval } from '@/lib/factory/server';
import { handleFactoryFlow } from '@/lib/factory/flow-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const respond = withRequestLog('/api/factory/tasks/[taskId]/flow', async (request: Request, context: { params: Promise<{ taskId: string }> }) => {
  const session = await factoryBrowserSession(request,headers => auth.api.getSession({ headers, query: { disableCookieCache: true } }));
  const actor = session ? { userId: session.user.id, sessionId: session.session.id } : null;
  noteLogUser(actor?.userId);
  return factoryHumanWorkspaceResponse(session?.user, async () => {
    const { taskId } = await context.params;
    const result = await handleFactoryFlow(pool,factoryHumanStore,factorySpecApproval,{
      // Only the fresh human session verified above may cross the browser/native
      // adapter. Invalid or delegated credentials retain the core's refusal.
      actor, authorization: actor ? null : request.headers.get('authorization'), method: request.method, taskId,
      origin: request.headers.get('origin'), url: request.url,
      ...(request.method === 'POST' ? { body: await request.json().catch(() => null) } : {}),
    });
    return NextResponse.json(result.body,{ status: result.status, headers: { 'Cache-Control': 'private, no-store' } });
  });

});
export const GET = respond;
export const POST = respond;
