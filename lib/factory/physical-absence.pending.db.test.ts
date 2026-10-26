import test from "node:test";
// REQUIRE_DB: separate pending contract; never execute from the retained recipe.
if (process.env.FACTORY_PHYSICAL_ABSENCE_AUTHORIZED !== "1")
  throw new Error("Pending scoped approval for synthetic agent/run/issue physical absence");
// The original setup and assertions remain shared, including all four deletion cases.
test("pending Factory physical absence with original retained setup", async () => {
await import("./postgres.test");
await import("./monitor.test");
await import("./questions/postgres.test");
});
