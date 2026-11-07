import type { FactoryHuman } from "./approval-contract";
import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'

/** Retain the full verified principal for workspace and enterprise admission. */
export async function factoryBrowserSession<T extends { user: { id: string }; session: { id: string } }>(
  request: Request,
  getSession: (headers: Headers) => Promise<T | null>,
): Promise<T | null> {
  const headers = humanSessionHeaders(request)
  return headers ? getSession(headers) : null
}

/** Only verified browser/native sessions cross this boundary; no delegated tokens. */
export async function factoryBrowserHuman(
  request: Request,
  getSession: (
    headers: Headers,
  ) => Promise<{ user: { id: string }; session: { id: string } } | null>,
): Promise<FactoryHuman | null> {
  const session = await factoryBrowserSession(request, getSession);
  return session
    ? { userId: session.user.id, sessionId: session.session.id }
    : null;
}
