import type { z } from 'zod';
/** Public-core-owned boundary. No SQL pool, signing private key or execution
 * bypass is exposed to the enterprise management adapter. */
export interface CorePolicyAdmin {
  readonly signer: { readonly keyId: string; readonly publicKey: string };
  read(workspaceId: string, actorId: string, version?: number): Promise<unknown>;
  current(actorId: string, workspaceId: string): Promise<readonly { signed: unknown }[]>;
  publish(workspaceId: string, actorId: string, expectedVersion: number,
    document?: unknown, rollbackOf?: number): Promise<unknown>;
}
export interface CorePolicyContract {
  readonly documentSchema: z.ZodType;
  readonly PolicyError: new (code: string, status: number) => Error & {code: string; status: number};
}
export interface CorePolicyAdminRuntime {
  admin(): CorePolicyAdmin;
  readonly contract: CorePolicyContract;
  readonly origin: string;
  /** Must resolve a real browser session without cookie-cache authorization. */
  authenticate(request: Request): Promise<{userId: string} | null>;
}
