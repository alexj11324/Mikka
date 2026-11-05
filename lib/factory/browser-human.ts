import type { FactoryHuman } from "./approval-contract";
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'

/** Only verified browser/native sessions cross this boundary; no delegated tokens. */
export async function factoryBrowserHuman(
  request: Request,
  getSession: (
    headers: Headers,
  ) => Promise<{ user: { id: string }; session: { id: string } } | null>,
): Promise<FactoryHuman | null> {
  const headers = humanSessionHeaders(request)
  if (!headers) return null;
  const session = await getSession(headers);
  return session
    ? { userId: session.user.id, sessionId: session.session.id }
    : null;
}
