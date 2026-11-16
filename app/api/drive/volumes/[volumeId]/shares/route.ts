import { driveResponse } from '@/lib/drive/server'

export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ volumeId: string }> }

export async function GET(request: Request, { params }: Context) {
  return driveResponse(request, 'links', await params)
}

export async function POST(request: Request, { params }: Context) {
  return driveResponse(request, 'links', await params)
}
