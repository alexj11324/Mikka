import { respondGroup } from '@/lib/group-conversations-route'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) { return respondGroup(request, 'conversations') }
export async function POST(request: Request) { return respondGroup(request, 'conversations') }
