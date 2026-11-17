import { driveResponse } from '@/lib/drive/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ shareId: string }> }) {
  return driveResponse(request, 'shareView', await context.params)
}
