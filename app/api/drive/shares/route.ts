import { driveResponse } from '@/lib/drive/server'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return driveResponse(request, 'workspaceLinks')
}
