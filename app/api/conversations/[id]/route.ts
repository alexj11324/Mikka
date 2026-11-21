import { respondGroup } from '@/lib/group-conversations-route'
type Context = { params: Promise<{ id: string }> }
export async function PATCH(request: Request, { params }: Context) { return respondGroup(request, 'conversations', (await params).id) }
