import { driveResponse } from '@/lib/drive/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function PATCH(request: Request, { params }: { params: Promise<{ volumeId: string }> }) {
  return driveResponse(request, 'write', await params)
}
