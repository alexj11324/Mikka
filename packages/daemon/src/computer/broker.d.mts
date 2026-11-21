import type { CaptureCall, ComputerDriver, ComputerCall } from "./driver.mjs";
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
  });
  spec(
    runId: string,
    permission?: string,
    options?: { display?: string },
  ): { socketPath: string; token: string } | undefined;
  listen(): Promise<void>;
  request(token: string, value: unknown, signal?: AbortSignal): Promise<unknown>;
  captureRequest(token: string, value: unknown, signal?: AbortSignal): Promise<{ result: unknown } | { error: string; detail?: string }>;
  revoke(token: string): void;
  suspend(): void;
  close(): Promise<void>;
}
