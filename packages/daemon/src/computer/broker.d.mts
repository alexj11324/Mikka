import type { CaptureCall, ComputerDriver, ComputerCall } from "./driver.mjs";
export interface PendingComputerRequest {
  id: string;
  runId: string;
  target: string;
  display?: string;
  call: ComputerCall;
  expiresAt: number;
  digest: string;
}
export class ComputerBroker {
  constructor(options: {
    driver: ComputerDriver | null;
    socketPath: string;
    permitted: (runId: string) => boolean;
    execute?: (driver: ComputerDriver, input: unknown, display: string | undefined, runId: string) => Promise<unknown>;
    /** Cloud computer captures, relayed to the server; throw an error with `safeMessage` to tell the model why. */
    capture?: (runId: string, call: CaptureCall, signal?: AbortSignal) => Promise<unknown>;
    now?: () => number;
    ttl?: number;
  });
  spec(
    runId: string,
    permission?: string,
    options?: { display?: string },
  ): { socketPath: string; token: string } | undefined;
  listen(): Promise<void>;
  request(token: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
  captureRequest(token: string, value: unknown, signal?: AbortSignal): Promise<{ result: unknown } | { error: string; detail?: string }>;
  list(): PendingComputerRequest[];
  decide(id: string, digest: string, approve: boolean): Promise<{ ok: true }>;
  close(): Promise<void>;
}
