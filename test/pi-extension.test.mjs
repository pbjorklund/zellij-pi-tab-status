import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers/lifecycle.mjs";

const modes = (h) => h.pipes.flatMap((message) => message.kind === "snapshot" ? [message.mode] : []);

test("lifecycle: compaction and settlement publish semantic transitions", async (t) => {
  const h = harness(t, { runtimeId: "lifecycle" });
  await h.start();
  await h.emit("session_before_compact", { reason: "threshold", willRetry: false });
  await h.emit("session_compact", { reason: "threshold", willRetry: false });
  await h.emit("agent_settled");

  assert.deepEqual(modes(h), ["base", "working", "compacting", "working", "done"]);
  assert.equal(h.hasHandler("agent_end"), false);
});

test("lifecycle: failed compaction restores the effective work state", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("session_before_compact");
  await h.emit("session_compact_failed", { aborted: false });
  assert.deepEqual(modes(h).slice(-2), ["compacting", "working"]);
});

test("perf: active work has no transport or title animation timer", async (t) => {
  const h = harness(t);
  await h.start();
  const calls = h.calls.length;
  const writes = h.writes.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, calls);
  assert.equal(h.writes.length, writes);
});

test("perf: transitions within the binding TTL do not repeat discovery or Git reads", async (t) => {
  const h = harness(t);
  await h.start();
  const panes = h.calls.filter(({ args }) => args[1] === "list-panes").length;
  const git = h.calls.filter(({ command }) => command === "git").length;
  await h.emit("agent_settled");
  assert.equal(h.calls.filter(({ args }) => args[1] === "list-panes").length, panes);
  assert.equal(h.calls.filter(({ command }) => command === "git").length, git);
  assert.equal(h.pipes.at(-1).mode, "done");
});
