import { driveResponse } from '@/lib/drive/server'


export async function GET(request: Request, context: { params: Promise<{ shareId: string }> }) {
  return driveResponse(request, 'shareView', await context.params)
}
