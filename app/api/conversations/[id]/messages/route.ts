import { respondGroup } from '@/lib/group-conversations-route'
export const dynamic = 'force-dynamic'
export const maxDuration = 300
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, { params }: Context) { return respondGroup(request, 'messages', (await params).id) }
export async function POST(request: Request, { params }: Context) { return respondGroup(request, 'messages', (await params).id) }
