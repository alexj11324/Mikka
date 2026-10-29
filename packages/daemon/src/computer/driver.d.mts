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
  leaseGuard?: { botId: string; ownerId: string; policyVersion: number },
  assertLive?: () => void,
  beforeAction?: () => Promise<void>,
): Promise<unknown>;
export type CaptureCall =
  | { action: "screenshot"; title: string }
  | { action: "start_recording"; title: string; maxSeconds?: number }
  | { action: "stop_recording" };
export const CAPTURE_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[];
export function normalizeCaptureCall(value: unknown): CaptureCall;
export function isCaptureTool(name: unknown): boolean;
