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
    transport?: "unix" | "tcp";
    permitted: (runId: string) => boolean;
    execute?: (driver: ComputerDriver, input: ComputerCall, display: string | undefined, runId: string, context: { actionId: string; assertLive: () => void }) => Promise<unknown>;
    /** Cloud computer captures, relayed to the server; throw an error with `safeMessage` to tell the model why. */
    capture?: (runId: string, call: CaptureCall, signal?: AbortSignal) => Promise<unknown>;
    now?: () => number;
    ttl?: number;
    /** Under `ask`: the Decisions API's call on one action. false executes, true goes to review, null executes (logged). Absent: every action is reviewed. */
    needsPerson?: (runId: string, evidence: { call: ComputerCall; recent: string[] }, signal?: AbortSignal) => Promise<boolean | null>;
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
  revoke(token: string): void;
  decide(id: string, digest: string, approve: boolean): Promise<{ ok: true }>;
  suspend(): void;
  close(): Promise<void>;
}
