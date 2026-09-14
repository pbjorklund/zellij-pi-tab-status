import test from "node:test";
import assert from "node:assert/strict";
import { flush, harness } from "./helpers/lifecycle.mjs";

const modes = (h) => h.pipes.flatMap((message) => message.kind === "snapshot" ? [message.mode] : []);

test("scheduling: lifecycle hooks do not wait for stalled Zellij", async (t) => {
  const h = harness(t);
  const held = h.hold((command) => command === "zellij");
  try {
    h.fire("session_start");
    await held.entered.promise;
    assert.equal(h.fire("agent_start"), undefined);
    assert.equal(h.fire("session_before_compact"), undefined);
    assert.equal(h.fire("session_compact_failed"), undefined);
    assert.equal(h.fire("agent_settled"), undefined);
  } finally {
    held.release.resolve();
    await flush();
  }
  assert.equal(modes(h).at(-1), "done");
});

test("scheduling: burst updates coalesce to the latest semantic state", async (t) => {
  const h = harness(t);
  const held = h.hold((_command, args) => args[0] === "pipe");
  h.fire("session_start");
  await held.entered.promise;
  h.fire("agent_start");
  h.fire("session_before_compact");
  h.fire("session_compact_failed");
  h.fire("agent_settled");
  held.release.resolve();
  await flush();
  assert.deepEqual(modes(h), ["base", "done"]);
});

test("scheduling: repeated same-mode subagent events add no transport", async (t) => {
  const h = harness(t);
  await h.start();
  const before = h.calls.length;
  for (let i = 0; i < 100; i++) h.fire("subagents:started", { id: `child-${i}` });
  await flush();
  assert.equal(h.calls.length, before);

  h.fire("agent_settled");
  for (let i = 0; i < 99; i++) h.fire("subagents:completed", { id: `child-${i}` });
  await flush();
  assert.equal(modes(h).at(-1), "working");
  await h.emit("subagents:failed", { id: "child-99" });
  assert.equal(modes(h).at(-1), "done");
});

test("scheduling: shutdown cancels discovery retries and publishes one removal", async (t) => {
  const h = harness(t, { runtimeId: "closing" });
  h.setPaneOutput("not json");
  h.fire("session_start");
  await flush();
  await h.fire("session_shutdown");
  const removals = h.pipes.filter(({ kind }) => kind === "remove");
  assert.equal(removals.length, 1);
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, count);
});

test("scheduling: a failed status pipe does not block the next transition", async (t) => {
  const h = harness(t);
  h.failPipes(1);
  await h.emit("session_start");
  await h.emit("agent_start");
  assert.equal(modes(h).at(-1), "working");
});

test("scheduling: an unexpected title clock failure does not stop later status", async (t) => {
  let failed = false;
  const h = harness(t, { now: () => {
    if (failed) throw new Error("clock failed");
    return Date.now();
  } });
  await h.start();
  failed = true;
  await h.emit("agent_settled");
  failed = false;
  await h.emit("agent_start");
  assert.equal(modes(h).at(-1), "working");
});

test("scheduling: viewing a done tab publishes base to every sidebar instance", async (t) => {
  const h = harness(t, { seenPollFirstDelayMs: 5 });
  await h.start();
  await h.emit("agent_settled");
  h.setActive(true);
  await h.tick(5);
  assert.equal(modes(h).at(-1), "base");
  const writes = h.writes.length;
  await h.tick(60_000);
  assert.equal(h.writes.length, writes, "seen polling must not animate the title");
});

test("scheduling: interactive input clears done but extension input does not", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("agent_settled");
  await h.emit("input", { source: "extension" });
  assert.equal(modes(h).at(-1), "done");
  await h.emit("input", { source: "interactive" });
  assert.equal(modes(h).at(-1), "base");
});

test("scheduling: invalid pane identity publishes nothing", async (t) => {
  const h = harness(t);
  process.env.ZELLIJ_PANE_ID = "not-a-pane";
  await h.start();
  assert.deepEqual(h.pipes, []);
});

for (const mode of ["rpc", "json", "print"]) {
  test(`scheduling: ${mode} lifecycle spawns nothing`, async (t) => {
    const h = harness(t, { ctx: { mode } });
    await h.start();
    h.fire("session_before_compact");
    h.fire("session_compact_failed");
    h.fire("subagents:started", { id: "child" });
    h.fire("agent_settled");
    h.fire("subagents:completed", { id: "child" });
    await flush();
    await h.tick(60_000);
    assert.deepEqual(h.calls, []);
  });
}
