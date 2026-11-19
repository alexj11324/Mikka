import { respondGroup } from '@/lib/group-conversations-route'
export async function GET(request: Request) { return respondGroup(request, 'conversations') }
export async function POST(request: Request) { return respondGroup(request, 'conversations') }
