import type { ComputerDriver, ComputerCall } from "./driver.mjs";
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
    execute?: (driver: ComputerDriver, input: unknown, display?: string) => Promise<unknown>;
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
  list(): PendingComputerRequest[];
  decide(id: string, digest: string, approve: boolean): Promise<{ ok: true }>;
  close(): Promise<void>;
}
