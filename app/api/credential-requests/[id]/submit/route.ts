import { handleCredentialRequest } from '@/lib/credentials/runtime'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCredentialRequest(request, 'submit', (await params).id)
}
