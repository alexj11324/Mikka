import { driveResponse } from '@/lib/drive/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: Request) {
  return driveResponse(request, 'volumes')
}

export async function POST(request: Request) {
  return driveResponse(request, 'volumes')
}
