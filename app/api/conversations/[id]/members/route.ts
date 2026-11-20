import { respondGroup } from '@/lib/group-conversations-route'
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, { params }: Context) { return respondGroup(request, 'members', (await params).id) }
export async function POST(request: Request, { params }: Context) { return respondGroup(request, 'members', (await params).id) }
export async function DELETE(request: Request, { params }: Context) { return respondGroup(request, 'members', (await params).id) }
