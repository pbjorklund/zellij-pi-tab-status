import test from "node:test";
import assert from "node:assert/strict";
import { parseJobUpdate } from "../lib/subagent-jobs.ts";

for (const [status, active] of [
  ["started", true], ["running", true], ["stopping", true],
  ["completed", false], ["failed", false], ["cancelled", false],
]) {
  test(`subagent updates: ${status} has a known activity state`, () => {
    assert.deepEqual(parseJobUpdate({ id: "child", status }), { id: "child", active });
  });
}

test("subagent updates: legacy job-shaped data remains readable during transition", () => {
  assert.deepEqual(parseJobUpdate({ jobId: "child", state: "running" }), { id: "child", active: true });
});

test("subagent updates: malformed and unknown payloads cannot change activity", () => {
  for (const value of [
    null, undefined, 1, "child", [], {}, { id: "child" },
    { id: "child", status: "unknown" }, { id: "child", status: true },
    { id: 1, status: "started" }, { id: " ", status: "started" },
    { id: "", status: "completed" },
  ]) {
    assert.equal(parseJobUpdate(value), null, JSON.stringify(value));
  }
});

test("subagent updates: identity is preserved without coercion or trimming", () => {
  assert.deepEqual(parseJobUpdate({ id: " child ", status: "running", timedOut: true }), {
    id: " child ", active: true,
  });
});
