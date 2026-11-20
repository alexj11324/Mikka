import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { listDispatchableDevices } from '@/lib/devices/dispatchable'

const headers = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ items: [] }, { status: 401, headers })
  const user = (await auth.api.getSession({ headers: request.headers }))?.user
  if (!user) return Response.json({ items: [] }, { status: 401, headers })
  return Response.json({ items: await listDispatchableDevices(pool.query.bind(pool), user.id) }, { headers })
}
