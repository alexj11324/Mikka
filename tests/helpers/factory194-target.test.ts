import assert from "node:assert/strict";
import test from "node:test";
import { factory194Target } from "./factory194-target";

test("isolated target validation cannot be overridden by URL search_path/options or external sockets", () => {
  const local =
    "postgresql://synthetic:synthetic@127.0.0.1:55594/factory194_test";
  for (const value of [
    local + "?options=-c%20search_path=public",
    local + "#fragment",
    local.replace("postgresql:", "https:"),
    local.replace("127.0.0.1", "localhost"),
    local.replace("55594", "5432"),
    "postgresql://synthetic:synthetic@127.0.0.1:5432/mikka_prod",
    "postgresql://synthetic:synthetic@10.0.0.5:5432/mikka_e2e",
    local.replace("factory194_test", "postgres"),
  ])
    assert.throws(
      () => factory194Target(value, false),
      /exact isolated loopback/,
    );
  const config = factory194Target(local, false);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 55594);
  assert.equal(config.options, "-c search_path=public");
  assert.equal(config.ssl, false);
  assert.equal("connectionString" in config, false);
  assert.equal(
    factory194Target(
      "postgresql://synthetic:synthetic@127.0.0.1:5432/mikka_e2e",
      true,
    ).database,
    "mikka_e2e",
  );
  assert.throws(() => factory194Target(local, true), /exact isolated loopback/);
  // Any *_e2e database on any loopback port is accepted, CI or not.
  for (const ci of [true, false])
    assert.equal(
      factory194Target("postgresql://s:s@127.0.0.1:55600/fac_overnight_e2e", ci).port,
      55600,
    );
});
