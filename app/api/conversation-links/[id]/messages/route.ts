import { respondGroup } from '@/lib/group-conversations-route'

export const dynamic = 'force-dynamic'

/** Membership in the source group grants only the link's bounded DM segment. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respondGroup(request, 'links', (await params).id)
}
