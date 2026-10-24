import { respondReview } from '@/lib/group-review-route'
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respondReview(request, (await params).id, 'review')
}
