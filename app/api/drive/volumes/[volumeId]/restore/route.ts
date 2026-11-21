import { driveResponse } from '@/lib/drive/server'

export const maxDuration = 60

export async function POST(request: Request, { params }: { params: Promise<{ volumeId: string }> }) {
  return driveResponse(request, 'restore', await params)
}
