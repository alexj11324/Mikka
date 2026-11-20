import { driveResponse } from '@/lib/drive/server'


export async function GET(request: Request) {
  return driveResponse(request, 'scopes')
}
