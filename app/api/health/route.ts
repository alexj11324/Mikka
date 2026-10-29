import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Read-only process liveness. It discloses no session, secrets or claimed SHA.
 * Database/business readiness still requires the independent verification and
 * real-user acceptance gates. Avoid querying the same pool held by monitor. */
export function GET() {
  return NextResponse.json(
    { status: "ok", service: "mikka" },
    {
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  );
}
