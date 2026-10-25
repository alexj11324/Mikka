import { handleCredentialRequest } from '@/lib/credentials/runtime'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCredentialRequest(request, 'events', (await params).id)
}
