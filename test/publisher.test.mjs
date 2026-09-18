import test from "node:test";
import assert from "node:assert/strict";
import { flush, harness } from "./helpers/lifecycle.mjs";

test("publisher: lifecycle transitions use snapshots instead of animated tab renames", async (t) => {
  const h = harness(t, { runtimeId: "run-1" });

  await h.emit("session_start");
  await h.emit("agent_start");
  const writesAfterStart = h.writes.length;
  await h.tick(5_000);

  assert.equal(h.writes.length, writesAfterStart, "animation must not rename the tab");
  const pipeCalls = h.calls.filter(({ command, args }) =>
    command === "zellij" && args[0] === "pipe" && !args.includes("action"));
  assert.ok(pipeCalls.length > 0);
  assert.ok(pipeCalls.every(({ options }) => options.stdio === "ignore"));
  const base = { v: 1, kind: "snapshot", runtime_id: "run-1", seq: 1, pane_id: 248, mode: "base" };
  const working = { v: 1, kind: "snapshot", runtime_id: "run-1", seq: 2, pane_id: 248, mode: "working" };
  assert.deepEqual(h.pipes, [base, working, working]);
});

test("publisher: duplicate modes are coalesced and shutdown removes only its runtime", async (t) => {
  const h = harness(t, { runtimeId: "run-2" });

  await h.emit("session_start");
  await h.emit("agent_start");
  h.fire("subagents:started", { id: "one" });
  h.fire("subagents:started", { id: "two" });
  await flush();
  assert.equal(h.pipes.filter(({ mode }) => mode === "working").length, 1);

  await h.fire("session_shutdown");
  assert.deepEqual(h.pipes.at(-1), {
    v: 1, kind: "remove", runtime_id: "run-2", seq: 3, pane_id: 248,
  });
});
