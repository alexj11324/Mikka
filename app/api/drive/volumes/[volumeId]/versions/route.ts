import { driveResponse } from '@/lib/drive/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request, { params }: { params: Promise<{ volumeId: string }> }) {
  return driveResponse(request, 'history', await params)
}
