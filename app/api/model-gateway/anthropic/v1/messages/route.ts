import { handleModelGateway } from '@/lib/model-gateway/handler'


/** The Mikka model gateway (decision 2026-11-15-2000): authenticated by the run's own gateway token, not a session. */
export async function POST(request: Request) {
  return handleModelGateway(request, 'anthropic', 'messages')
}
