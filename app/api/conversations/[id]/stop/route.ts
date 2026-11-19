import { respondGroup } from '@/lib/group-conversations-route'
type Context = { params: Promise<{ id: string }> }
/** `POST /api/conversations/:id/stop`: 停止 the group's reply in progress (and any still queued). */
export async function POST(request: Request, { params }: Context) { return respondGroup(request, 'stop', (await params).id) }
