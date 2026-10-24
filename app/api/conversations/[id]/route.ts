import { respondGroup } from '@/lib/group-conversations-route'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
export async function PATCH(request: Request, { params }: Context) { return respondGroup(request, 'conversations', (await params).id) }
