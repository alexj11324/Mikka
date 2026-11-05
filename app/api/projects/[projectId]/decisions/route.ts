import { decisionsHttp } from '@/lib/project-map/http'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ projectId: string }> }
export async function GET(request: Request, context: Context) { return decisionsHttp(request, (await context.params).projectId) }
export async function POST(request: Request, context: Context) { return decisionsHttp(request, (await context.params).projectId) }
