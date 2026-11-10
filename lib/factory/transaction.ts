import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { db } from "../db";

type DispatchDatabase = Pick<typeof db, "select" | "transaction">;
type DispatchTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** #191's transaction callback joins a caller-owned BEGIN; it must not COMMIT it. */
export function factoryDispatchDatabase(tx: PoolClient): DispatchDatabase {
  const executor = drizzle(tx);
  return {
    select: executor.select.bind(executor),
    transaction: async (callback) =>
      callback(executor as unknown as DispatchTransaction),
  };
}


type ProfileScope = import('./agent-profile-definition').AgentProfileScope;
type ProfileSelection = import('./agent-profile-definition').AgentProfileSelection;
type ProfileLease = import('./agent-profile-store').ProfileMembership;
type ProfileAuthority = { scope: ProfileScope; selection?: ProfileSelection };
type FactoryTransactionState = { profiles: Map<string, ProfileAuthority> };
const factoryTransactions = new WeakMap<PoolClient, FactoryTransactionState>();

/** Only the Factory transaction owner opens this boundary. A nested queue
 * shares its APP client and registers authority for the owner's actual COMMIT. */
export async function beginFactoryTransaction(tx: PoolClient) {
  if (factoryTransactions.has(tx)) throw new Error('factoryTransactionAlreadyOwned');
  await tx.query('BEGIN');
  factoryTransactions.set(tx, { profiles: new Map() });
}
export function assertFactoryTransaction(tx: PoolClient) {
  if (!factoryTransactions.has(tx)) throw new Error('factoryTransactionNotOwned');
}
export function registerFactoryProfile(tx: PoolClient, scope: ProfileScope, selection?: ProfileSelection) {
  assertFactoryTransaction(tx);
  const key = JSON.stringify([scope.ownerId, scope.workspaceId, selection?.profileId, selection?.version, selection?.digest, selection?.targetEntry]);
  factoryTransactions.get(tx)!.profiles.set(key, structuredClone({ scope, selection }));
}
/** A savepoint rollback also discards authority registered by its queue. */
export function factoryAuthorizationCheckpoint(tx: PoolClient): () => void {
  assertFactoryTransaction(tx);
  const state = factoryTransactions.get(tx)!;
  const profiles = new Map(state.profiles);
  return () => {
    if (factoryTransactions.get(tx) !== state) throw new Error('factoryTransactionNotOwned');
    state.profiles = new Map(profiles);
  };
}
/** Slow planning precedes fresh membership acquisition. Source/Profile locks
 * stay on tx; the real membership lease remains pinned through this COMMIT. */
export async function commitFactoryTransaction(tx: PoolClient,
  heldMembership?: { ownerId: string; workspaceId: string; check: () => Promise<void> }) {
  assertFactoryTransaction(tx);
  const profiles = [...factoryTransactions.get(tx)!.profiles.values()];
  const members: ProfileLease[] = [];
  let committed = false;
  try {
    if (profiles.length) {
      const [{ assertProfileSelection }, { acquireProfileMembership }] = await Promise.all([
        import('./agent-profile'), import('./agent-profile-store'),
      ]);
      const scopes = new Map<string, ProfileScope>();
      for (const { scope, selection } of profiles) {
        if (selection) await assertProfileSelection(tx, scope, selection);
        scopes.set(JSON.stringify([scope.ownerId, scope.workspaceId]), scope);
      }
      for (const [, scope] of [...scopes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (heldMembership) {
          // A composing owner may already hold these exact WS/member locks.
          // A second lease behind a waiting deletion would deadlock its own
          // first lease; retain and check the original through this COMMIT.
          if (scope.ownerId !== heldMembership.ownerId || scope.workspaceId !== heldMembership.workspaceId)
            throw new Error('factoryProfileMembershipMismatch');
          await heldMembership.check();
        } else members.push(await acquireProfileMembership(scope));
      }
      for (const member of members) await member.check();
    }
    await tx.query('COMMIT');
    committed = true;
  } finally {
    factoryTransactions.delete(tx);
    const closed = await Promise.allSettled(members.map(member => member.close()));
    // Cleanup cannot turn a confirmed COMMIT into a rollback or replace the
    // original authorization/COMMIT failure. Never log member/credential data.
    if (closed.some(result => result.status === 'rejected')) console.warn(JSON.stringify({ msg: 'factory_profile_membership_cleanup_failed', committed }));
  }
}
export async function rollbackFactoryTransaction(tx: PoolClient) {
  try { await tx.query('ROLLBACK'); }
  finally { factoryTransactions.delete(tx); }
}
/** Also clear state if a transport failure prevents ordinary rollback. */
export function forgetFactoryTransaction(tx: PoolClient) { factoryTransactions.delete(tx); }
