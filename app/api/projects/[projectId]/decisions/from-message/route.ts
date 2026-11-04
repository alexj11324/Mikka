import { decisionsHttp } from '@/lib/project-map/http'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) { return decisionsHttp(request, (await context.params).projectId, true) }
