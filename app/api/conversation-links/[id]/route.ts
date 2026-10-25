import { respondConversationLink } from '@/lib/conversation-links-route'
export const dynamic = 'force-dynamic'
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respondConversationLink(request, (await params).id)
}
