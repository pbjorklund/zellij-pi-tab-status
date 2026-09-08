import test from "node:test";
import assert from "node:assert/strict";
import { parseJobUpdate } from "../lib/subagent-jobs.ts";

for (const [state, active] of [
  ["queued", true], ["running", true], ["completed", false], ["partial", false],
  ["failed", false], ["timed_out", false], ["cancelled", false],
]) {
  test(`job updates: ${state} has a known activity state`, () => {
    assert.deepEqual(parseJobUpdate({ jobId: "child", state }), { id: "child", active });
  });
}

test("job updates: malformed and unknown payloads cannot change activity", () => {
  for (const value of [
    null, undefined, 1, "child", [], {}, { jobId: "child" },
    { jobId: "child", state: "unknown" }, { jobId: "child", state: true },
    { jobId: 1, state: "queued" }, { jobId: " ", state: "queued" },
    { jobId: "", state: "completed" }, { id: "legacy", state: "running" },
  ]) {
    assert.equal(parseJobUpdate(value), null, JSON.stringify(value));
  }
});

test("job updates: job identity is preserved without coercion or trimming", () => {
  assert.deepEqual(parseJobUpdate({ jobId: " child ", state: "running", timedOut: true }), {
    id: " child ", active: true,
  });
});
