import { readdir, readFile } from "node:fs/promises";
import { execa } from "execa";
import { buildChildEnv } from "./env";

export async function detectDeviceType(): Promise<"laptop" | "server"> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execa("sysctl", ["-n", "hw.model"], {
        env: buildChildEnv(),
        extendEnv: false,
        timeout: 2000,
      });
      return /MacBook/i.test(stdout) ? "laptop" : "server";
    }
    if (process.platform === "linux") {
      const entries = await readdir("/sys/class/power_supply");
      const types = await Promise.all(
        entries.map((entry) =>
          readFile(`/sys/class/power_supply/${entry}/type`, "utf8").catch(
            () => "",
          ),
        ),
      );
      if (types.some((type) => type.trim() === "Battery")) return "laptop";
    }
  } catch {
    /* Headless/server platforms need no system utilities. */
  }
  return "server";
}
