import { threadComputerRoute } from '@/lib/computer/thread-route'
export const runtime = 'nodejs'
export const maxDuration = 300
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return threadComputerRoute(request, (await params).runId, 'viewer')
}
