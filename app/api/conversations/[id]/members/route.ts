import { respondGroup } from '@/lib/group-conversations-route'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, { params }: Context) { return respondGroup(request, 'members', (await params).id) }
export async function POST(request: Request, { params }: Context) { return respondGroup(request, 'members', (await params).id) }
export async function DELETE(request: Request, { params }: Context) { return respondGroup(request, 'members', (await params).id) }
