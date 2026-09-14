import test from "node:test";
import assert from "node:assert/strict";
import { flush, harness } from "./helpers/lifecycle.mjs";

const jobResult = (jobId, state = "queued", toolName = "subagent_spawn") => ({
  toolName, isError: false, result: { details: { jobId, state } },
});
const completion = (jobId, state = "completed") => ({
  type: "custom_message", customType: "pi-subagents-completion", details: { jobId, state },
});
const modes = (h) => h.pipes.flatMap((message) => message.kind === "snapshot" ? [message.mode] : []);

for (const reason of ["threshold", "overflow", "manual"]) {
  test(`activity: ${reason} compaction publishes transitions without frame traffic`, async (t) => {
    const h = harness(t);
    await h.emit("session_start");
    await h.emit("session_before_compact", { reason, willRetry: false });
    const calls = h.calls.length;
    await h.tick(5_000);
    assert.equal(h.calls.length, calls);
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

for (const state of ["completed", "partial", "failed", "timed_out", "cancelled"]) {
  test(`activity: current child ${state} completion publishes done`, async (t) => {
    const h = harness(t);
    await h.emit("session_start");
    await h.emit("tool_execution_end", jobResult("job-one"));
    h.appendEntry(completion("job-one", state));
    await h.tick(500);
    assert.equal(modes(h).at(-1), "done");
  });
}

test("activity: terminal inspect state completes a tracked job", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  await h.emit("tool_execution_end", jobResult("job-one"));
  await h.emit("tool_execution_end", {
    toolName: "subagent_inspect", isError: false,
    result: { details: { jobs: [{ jobId: "job-one", state: "completed" }] } },
  });
  assert.equal(modes(h).at(-1), "done");
});

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
  h.fire("tool_execution_end", jobResult("unrelated", "queued", "bash"));
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
