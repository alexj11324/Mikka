import { driveResponse } from '@/lib/drive/server'


type Context = { params: Promise<{ volumeId: string; shareId: string }> }

export async function GET(request: Request, { params }: Context) {
  return driveResponse(request, 'link', await params)
}

export async function PATCH(request: Request, { params }: Context) {
  return driveResponse(request, 'link', await params)
}

export async function DELETE(request: Request, { params }: Context) {
  return driveResponse(request, 'link', await params)
}
