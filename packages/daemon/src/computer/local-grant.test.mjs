import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerBroker } from "./broker.mjs";
import { localComputerMcp } from "./local-grant.mjs";

test("local computer injection requires a driver, explicit permission and a writable run", async () => {
  let executions = 0;
  const driver = { installed: true, path: "/driver", version: "cua-driver 0.38.0", fingerprint: "a".repeat(64) };
  const broker = new ComputerBroker({ driver, socketPath: "/test/socket", permitted: () => true, execute: async () => { executions++; return "done"; } });
  const options = { broker, runId: "run", proxyPath: "/app/proxy.mjs", nodeBinary: "/usr/bin/node" };
  for (const permission of [undefined, "deny", "unknown"]) assert.equal(localComputerMcp({ ...options, permission }), undefined);
  assert.equal(localComputerMcp({ ...options, permission: "allow", readOnly: true }), undefined);
  const absent = new ComputerBroker({ driver: null, socketPath: "/test/absent", permitted: () => true });
  assert.equal(localComputerMcp({ ...options, broker: absent, permission: "ask" }), undefined);
  for (const permission of ["ask", "allow"]) {
    const spec = localComputerMcp({ ...options, permission });
    assert.equal(spec.command, "/usr/bin/node");
    assert.equal(spec.args[0], "/app/proxy.mjs");
    assert.equal(spec.args[1], "/test/socket");
    assert.notEqual(spec.command, driver.path);
    const pending = broker.request(spec.args[2], { name: "click", arguments: { x: 3, y: 4 } });
    assert.equal(executions, permission === "ask" ? 0 : 1);
    const [review] = broker.list();
    await broker.decide(review.id, review.digest, true);
    assert.equal(await pending, "done");
  }
  assert.equal(executions, 2);
  await broker.close();
  await absent.close();
});
