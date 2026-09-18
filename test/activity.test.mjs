import test from "node:test";
import assert from "node:assert/strict";
import { flush, harness } from "./helpers/lifecycle.mjs";

const jobResult = (id, status = "started", toolName = "subagent") => ({
  toolName, isError: false, result: { details: { id, status } },
});
const completion = (id, status = "completed") => ({
  type: "custom_message", customType: "subagent_result", details: { id, status },
});
const modes = (h) => h.pipes.flatMap((message) => message.kind === "snapshot" ? [message.mode] : []);

for (const reason of ["threshold", "overflow", "manual"]) {
  test(`activity: ${reason} compaction replays status without title frame traffic`, async (t) => {
    const h = harness(t);
    await h.emit("session_start");
    await h.emit("session_before_compact", { reason, willRetry: false });
    const compacting = h.pipes.at(-1);
    const writes = h.writes.length;
    await h.tick(5_000);
    assert.deepEqual(h.pipes.slice(-2), [compacting, compacting]);
    assert.equal(h.writes.length, writes);
    await h.emit("session_compact", { reason, willRetry: false });
    assert.deepEqual(modes(h).slice(-2), ["compacting", "base"]);
  });
}

for (const terminal of ["session_compact", "session_compact_failed"]) {
  test(`activity: child completion during ${terminal} remains done`, async (t) => {
    const h = harness(t);
    await h.emit("session_start");
    await h.emit("subagents:started", { id: "child" });
    await h.emit("session_before_compact");
    h.fire("subagents:completed", { id: "child" });
    await h.emit(terminal);
    assert.equal(modes(h).at(-1), "done");
  });
}

test("activity: current subagent jobs keep working after parent settlement", async (t) => {
  const h = harness(t);
  await h.start();
  h.fire("tool_execution_end", jobResult("job-one"));
  h.fire("agent_settled");
  await flush();
  assert.equal(modes(h).at(-1), "working");
  h.appendEntry(completion("job-one"));
  await h.tick(500);
  assert.equal(modes(h).at(-1), "done");
});

test("activity: same-mode subagent events repair a failed working snapshot", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  h.failPipes(1);
  await h.emit("agent_start");

  h.fire("tool_execution_end", jobResult("job-one"));
  h.fire("tool_execution_end", jobResult("job-two"));
  h.fire("agent_settled");
  await flush();

  assert.equal(modes(h).at(-1), "working");
  h.appendEntry(completion("job-one"));
  await h.tick(500);
  assert.equal(modes(h).at(-1), "working");
  h.appendEntry(completion("job-two"));
  await h.tick(500);
  assert.equal(modes(h).at(-1), "done");
});

for (const state of ["completed", "failed", "cancelled"]) {
  test(`activity: current child ${state} completion publishes done`, async (t) => {
    const h = harness(t);
    await h.emit("session_start");
    await h.emit("tool_execution_end", jobResult("job-one"));
    h.appendEntry(completion("job-one", state));
    await h.tick(500);
    assert.equal(modes(h).at(-1), "done");
  });
}

test("activity: malformed and unrelated job events publish no extra status", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  const before = h.pipes.length;
  for (const event of [null, undefined, 1, "job", [], {}, { id: " " }]) {
    h.fire("subagents:started", event);
    h.fire("subagents:completed", event);
    h.fire("subagents:failed", event);
  }
  h.fire("tool_execution_end", { ...jobResult("error"), isError: true });
  h.fire("tool_execution_end", jobResult("unrelated", "started", "bash"));
  await flush();
  assert.equal(h.pipes.length, before);
});

test("activity: job polling reads only new entries and stops after completion", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 100; i++) h.appendEntry({ type: "message" });
  await h.emit("session_start");
  await h.emit("tool_execution_end", jobResult("job-one"));
  h.appendEntry({ type: "message" });
  h.appendEntry(completion("job-one"));
  await h.tick(500);
  assert.equal(h.entryReads(), 2);
  const reads = h.entryReads();
  await h.tick(5_000);
  assert.equal(h.entryReads(), reads);
  assert.equal(modes(h).at(-1), "done");
});
