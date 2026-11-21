import { respondGroupDecisionQuality } from '@/lib/group-conversations-route'
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, { params }: Context) { return respondGroupDecisionQuality(request, (await params).id) }
export async function POST(request: Request, { params }: Context) { return respondGroupDecisionQuality(request, (await params).id) }
