import type { PoolConfig } from "pg";
import { isE2eTarget } from "./e2e-target.mjs";

/** Validate at the fixture boundary BEFORE constructing any Pool. Never pass a
 * connectionString to pg: URL parameters can override options/search_path.
 * Explicit options also prevent PGOPTIONS from choosing an external schema. */
export function factory194Target(
  connectionString: string,
  ci: boolean,
): PoolConfig {
  const u = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(u.protocol) ||
    u.hostname !== "127.0.0.1" ||
    // Any loopback *_e2e database on any port; the legacy local name stays accepted.
    !(isE2eTarget(connectionString) ||
      (!ci && u.port === "55594" && u.pathname === "/factory194_test")) ||
    u.search ||
    u.hash
  )
    throw new Error(
      "Factory194 requires its exact isolated loopback target without URL options",
    );
  return {
    host: u.hostname,
    port: Number(u.port),
    database: u.pathname.slice(1),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: false,
    options: "-c search_path=public",
  };
}
