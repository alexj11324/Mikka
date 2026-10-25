import type { FactoryHuman } from "./approval-contract";

/** Only verified browser sessions can cross this boundary; no delegated tokens. */
export async function factoryBrowserHuman(
  request: Request,
  getSession: (
    headers: Headers,
  ) => Promise<{ user: { id: string }; session: { id: string } } | null>,
): Promise<FactoryHuman | null> {
  if (request.headers.has("authorization") || !request.headers.get("cookie"))
    return null;
  const session = await getSession(request.headers);
  return session
    ? { userId: session.user.id, sessionId: session.session.id }
    : null;
}
