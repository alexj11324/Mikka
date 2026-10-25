import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readCredentialInput, runCli } from "../src/cli";
import { cleanupTempDirs, tempDir } from "./helpers";
afterEach(cleanupTempDirs);
async function* input(value: string) {
  yield Buffer.from(value);
}
it("accepts one pipe credential and rejects malformed or oversized input", async () => {
  expect(await readCredentialInput(input("synthetic-token\n"))).toBe(
    "synthetic-token",
  );
  for (const value of ["", "a\nb", "a b", "a\0b", "a".repeat(8193)])
    await expect(readCredentialInput(input(value))).rejects.toThrow(
      "invalid_credential_input",
    );
});
it("stores a synthetic device token without logging it or taking it in argv", async () => {
  const root = tempDir(),
    token = "synthetic-private-" + randomUUID(),
    workspace = randomUUID(),
    output: string[] = [];
  const result = await runCli(
    [
      "daemon",
      "login",
      "--token-stdin",
      "--data-dir",
      root,
      "--workspace",
      workspace,
    ],
    {
      out: (s) => output.push(s),
      err: (s) => output.push(s),
      credentialInput: input(token + "\n"),
    },
  );
  expect(result).toBe(0);
  expect(
    JSON.parse(readFileSync(join(root, "device.json"), "utf8")),
  ).toMatchObject({ credential: token, workspaceId: workspace });
  expect(statSync(join(root, "device.json")).mode & 0o777).toBe(0o600);
  expect(output.join("\n")).not.toContain(token);
});
it("rejects conflicting modes before reading input; malformed input cannot fall back to OAuth", async () => {
  let reads = 0;
  const source = {
    async *[Symbol.asyncIterator]() {
      reads++;
      yield "a b";
    },
  };
  const output: string[] = [];
  const io = {
    out: (s: string) => output.push(s),
    err: (s: string) => output.push(s),
    credentialInput: source,
  };
  expect(await runCli(["daemon", "--token-stdin"], io)).toBe(2);
  expect(
    await runCli(
      ["daemon", "login", "--token-stdin", "--token", "synthetic"],
      io,
    ),
  ).toBe(2);
  expect(reads).toBe(0);
  expect(await runCli(["daemon", "login", "--token-stdin"], io)).toBe(2);
  expect(reads).toBe(1);
  expect(output.join("\n")).not.toContain("a b");
});
