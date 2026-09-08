import test from "node:test";
import assert from "node:assert/strict";
import { flush, harness } from "./helpers/lifecycle.mjs";

for (const reason of ["threshold", "overflow", "manual"]) {
  test(`scheduling: ${reason} compaction animates without parent work`, async (t) => {
    const h = harness(t);
    h.fire("session_start");
    h.fire("session_before_compact", { reason, willRetry: false });
    await flush();
    assert.equal(h.writes.at(-1)?.name, "◐ repo:main");
    await h.tick(500);
    assert.equal(h.writes.at(-1)?.name, "◓ repo:main");
    h.fire("session_compact", { reason, willRetry: false });
    await flush();
    assert.equal(h.writes.at(-1)?.name, "repo:main");
    const count = h.calls.length;
    await h.tick(5_000);
    assert.equal(h.calls.length, count);
  });
}

for (const terminal of ["session_compact", "session_compact_failed"]) {
  for (const provider of ["legacy", "current"]) {
    test(`activity: ${provider} completion during ${terminal} remains unseen`, async (t) => {
      const h = harness(t);
      h.fire("session_start");
      if (provider === "legacy") h.fire("subagents:started", { id: "child" });
      else h.fire("tool_execution_end", jobResult("child"));
      h.fire("session_before_compact", { reason: "manual" });
      await flush();
      if (provider === "legacy") h.fire("subagents:completed", { id: "child" });
      else h.appendEntry(completion("child"));
      await h.tick(500);
      assert.match(h.writes.at(-1)?.name, /^[◐◓◑◒] repo:main$/);
      h.fire(terminal);
      await flush();
      assert.equal(h.writes.at(-1)?.name, "● repo:main");
    });
  }
}

const jobResult = (jobId, state = "queued", toolName = "subagent_spawn") => ({
  toolName, isError: false, result: { details: { jobId, state } },
});
const completion = (jobId, state = "completed") => ({
  type: "custom_message", customType: "pi-subagents-completion", details: { jobId, state },
});

test("scheduling: current subagent jobs animate after parent settlement and finish while idle", async (t) => {
  const h = harness(t);
  await h.start();
  h.fire("tool_execution_end", jobResult("job-one"));
  h.fire("tool_execution_end", jobResult("job-two"));
  h.fire("agent_settled");
  await flush();
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "⠙ repo:main");
  h.appendEntry(completion("job-one"));
  await h.tick(500);
  assert.match(h.writes.at(-1)?.name, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);
  h.appendEntry(completion("job-two"));
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
  const reads = h.entryReads();
  h.appendEntry({ type: "message" });
  await h.tick(5_000);
  assert.equal(h.entryReads(), reads, "no session polling once children finish");
});

test("scheduling: compaction failure restores child-only work", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  h.fire("tool_execution_end", jobResult("job-one"));
  await flush();
  h.fire("session_before_compact", { reason: "threshold" });
  await flush();
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "◓ repo:main");
  h.fire("session_compact_failed", { aborted: true });
  await flush();
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "⠙ repo:main");
});

for (const state of ["completed", "partial", "failed", "timed_out", "cancelled"]) {
  test(`scheduling: current child ${state} completion stops child-only activity`, async (t) => {
    const h = harness(t);
    h.fire("session_start");
    h.fire("tool_execution_end", jobResult("job-one"));
    await flush();
    assert.equal(h.writes.at(-1)?.name, "⠋ repo:main");
    h.appendEntry(completion("job-one", state));
    await h.tick(500);
    assert.equal(h.writes.at(-1)?.name, "● repo:main");
  });
}

test("scheduling: current job tracking ignores errors, unrelated tools, and wait timeouts", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  h.fire("tool_execution_end", { ...jobResult("error"), isError: true });
  h.fire("tool_execution_end", jobResult("unrelated", "queued", "bash"));
  h.fire("tool_execution_end", jobResult("bad", "unknown"));
  await flush();
  assert.deepEqual(h.writes, []);
  h.fire("tool_execution_end", jobResult("job-one"));
  h.fire("tool_execution_end", { ...jobResult("job-one", "running", "subagent_wait"),
    result: { details: { jobId: "job-one", state: "running", timedOut: true } },
  });
  await flush();
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "⠙ repo:main");
  h.fire("tool_execution_end", jobResult("job-one", "cancelled", "subagent_cancel"));
  await flush();
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
});

test("scheduling: malformed legacy events cannot interrupt status handling", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  for (const event of [null, undefined, 1, "job", [], {}, { id: " " }]) {
    h.fire("subagents:started", event);
    h.fire("subagents:completed", event);
    h.fire("subagents:failed", event);
  }
  await flush();
  assert.deepEqual(h.writes, []);
});

test("scheduling: legacy and current subagents can keep the same parent idle", async (t) => {
  const h = harness(t);
  await h.start();
  h.fire("subagents:started", { id: "legacy-child" });
  h.fire("tool_execution_end", jobResult("current-child"));
  h.fire("agent_settled");
  h.appendEntry(completion("current-child"));
  await h.tick(500);
  assert.match(h.writes.at(-1)?.name, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);
  h.fire("subagents:completed", { id: "legacy-child" });
  await flush();
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
});

test("scheduling: job polling reads only the new tail and stops on shutdown", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 100; i++) h.appendEntry({ type: "message" });
  h.fire("session_start");
  h.fire("tool_execution_end", jobResult("job-one"));
  await flush();
  await h.tick(500);
  assert.equal(h.entryReads(), 0);
  h.appendEntry({ type: "message" });
  h.appendEntry({ ...completion("job-one"), customType: "unrelated" });
  await h.tick(500);
  assert.equal(h.entryReads(), 2);
  assert.match(h.writes.at(-1)?.name, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);
  await h.tick(500);
  assert.equal(h.entryReads(), 2);
  await h.fire("session_shutdown");
  h.appendEntry(completion("job-one"));
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.entryReads(), 2);
  assert.equal(h.calls.length, count);
});

test("scheduling: terminal inspect results and duplicate spawn results do not revive jobs", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  h.fire("tool_execution_end", jobResult("job-one"));
  h.fire("tool_execution_end", { toolName: "subagent_inspect", isError: false,
    result: { details: { jobs: [{ jobId: "job-one", state: "completed" }] } },
  });
  h.fire("tool_execution_end", jobResult("job-one"));
  await flush();
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
});

test("scheduling: current completion before spawn result cannot leave a stuck spinner", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  h.appendEntry(completion("fast-job"));
  h.fire("tool_execution_end", jobResult("fast-job"));
  await flush();
  await h.tick(500);
  assert.doesNotMatch(h.writes.at(-1)?.name ?? "", /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});
