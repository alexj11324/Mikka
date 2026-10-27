export interface ComputerDriver {
  installed: true;
  version: string;
  path: string;
  fingerprint: string;
}
export interface ComputerCall {
  name: string;
  arguments: Record<string, unknown>;
}
export function detectComputerDriver(
  binary?: string,
): Promise<ComputerDriver | null>;
export function normalizeCall(value: unknown): ComputerCall;
export function executeDriver(
  driver: ComputerDriver,
  input: unknown,
  display?: string,
  leaseGuard?: { botId: string; ownerId: string; policyVersion: number; permitted?: () => boolean },
): Promise<unknown>;
