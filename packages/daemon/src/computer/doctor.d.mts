import type { ComputerDoctor } from "@mikka/protocol/computer";
import type {
  ComputerDriver,
  ComputerDriverInspection,
  ComputerPermissions,
  ComputerProbe,
} from "./driver.mjs";

export interface DoctorOptions {
  binary?: string;
  platform?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  /** A look the caller already took; the report reuses it instead of re-detecting. */
  inspection?: ComputerDriverInspection;
  inspect?: (
    binary: string | undefined,
    options: { platform: string; env: Record<string, string | undefined>; home?: string },
  ) => Promise<ComputerDriverInspection>;
  permissions?: (driver: ComputerDriver, options: { platform: string }) => Promise<ComputerPermissions>;
  probe?: (driver: ComputerDriver) => Promise<ComputerProbe>;
  grant?: (driver: ComputerDriver, options: { platform: string }) => Promise<void>;
}

export function computerDoctorStatus(input: {
  accessibility: string;
  screenRecording: string;
  captureConsent: string;
  probeOk: boolean;
}): ComputerDoctor["probe"]["status"];
export function doctorComputerDriver(options?: DoctorOptions): Promise<ComputerDoctor>;
export function grantComputerAccess(options?: DoctorOptions): Promise<ComputerDoctor>;
