import { request } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeSubscriptionBroker } from "../src/subscription-native-broker";
import { cleanupTempDirs, tempDir } from "./helpers";

afterEach(cleanupTempDirs);
const post = (socket: string, parts: Buffer[]) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const call = request(
      { socketPath: socket, path: "/v1/messages", method: "POST" },
      (response) => {
        let text = "";
        response.on("data", (part) => {
          text += part;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, text }),
        );
      },
    );
    call.on("error", reject);
    for (const part of parts) call.write(part);
    call.end();
  });
it("uses only its bound worker, preserves UTF-8 input and stops all provider use after revocation", async () => {
  let connected = true;
  const nativeRequest = vi.fn(async (_revision, payload) => ({
    contentType: "application/json",
    body: new Response(
      JSON.stringify({ text: payload.body.messages[0].content }),
    ).body!,
  }));
  const broker = await createNativeSubscriptionBroker({
    root: tempDir(),
    revision: 7,
    check: async () => {
      if (!connected) throw new Error("revoked");
    },
    worker: { nativeRequest },
  });
  try {
    const bytes = Buffer.from(
      JSON.stringify({
        model: "bound-model",
        messages: [{ role: "user", content: "汉字🙂" }],
      }),
    );
    const result = await post(
      broker.socket,
      [...bytes].map((byte) => Buffer.from([byte])),
    );
    expect(result).toEqual({
      status: 200,
      text: JSON.stringify({ text: "汉字🙂" }),
    });
    expect(nativeRequest).toHaveBeenCalledOnce();
    expect(nativeRequest.mock.calls[0][0]).toBe(7);
    connected = false;
    expect((await post(broker.socket, [bytes])).status).toBe(503);
    expect((await post(broker.socket, [bytes])).status).toBe(503);
    expect(nativeRequest).toHaveBeenCalledOnce();
  } finally {
    await broker.close();
  }
});
it("halts retries after an uncertain worker failure and returns fixed errors only", async () => {
  const nativeRequest = vi.fn(async () => {
    throw new Error("synthetic-private-provider-diagnostic");
  });
  const broker = await createNativeSubscriptionBroker({
    root: tempDir(),
    revision: 7,
    check: async () => {},
    worker: { nativeRequest },
  });
  try {
    const bytes = Buffer.from('{"model":"bound-model"}');
    const result = await post(broker.socket, [bytes]);
    expect(result.status).toBe(503);
    expect(result.text).not.toContain("synthetic-private");
    expect((await post(broker.socket, [bytes])).status).toBe(503);
    expect(nativeRequest).toHaveBeenCalledOnce();
  } finally {
    await broker.close();
  }
});
