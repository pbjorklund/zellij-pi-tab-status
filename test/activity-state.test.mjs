import test from "node:test";
import assert from "node:assert/strict";
import { createActivityState } from "../lib/activity.ts";

const cases = [
  ["idle compaction returns to base", [
    ["mode", "base"], ["startCompaction", "compacting"], ["mode", "compacting"],
    ["finishCompaction", "base"],
  ]],
  ["parent settlement survives compaction", [
    ["startParent", "working"], ["startCompaction", "compacting"],
    ["settleParent", "compacting"], ["finishCompaction", "done"],
  ]],
  ["child completion survives compaction", [
    ["startChild", "working", "child"], ["startCompaction", "compacting"],
    ["finishChild", "compacting", "child"], ["finishCompaction", "done"],
  ]],
  ["settlement waits for every child", [
    ["startParent", "working"], ["startChild", "working", "first"],
    ["startChild", "working", "second"], ["settleParent", "working"],
    ["finishChild", "working", "first"], ["finishChild", "done", "second"],
  ]],
  ["unfinished child resumes after compaction", [
    ["startParent", "working"], ["startChild", "working", "child"],
    ["startCompaction", "compacting"], ["settleParent", "compacting"],
    ["finishCompaction", "working"], ["finishChild", "done", "child"],
  ]],
  ["new work takes precedence over completion during compaction", [
    ["startChild", "working", "child"], ["startCompaction", "compacting"],
    ["finishChild", "compacting", "child"], ["startParent", "compacting"],
    ["finishCompaction", "working"], ["settleParent", "done"],
  ]],
  ["a later compaction does not replay a previous completion", [
    ["startParent", "working"], ["startCompaction", "compacting"],
    ["settleParent", "compacting"], ["finishCompaction", "done"],
    ["startCompaction", "compacting"], ["finishCompaction", "base"],
  ]],
];

for (const [name, steps] of cases) {
  test(`activity state: ${name}`, () => {
    const activity = createActivityState();
    for (const [action, expected, id] of steps) {
      assert.equal(activity[action](id), expected, action);
    }
  });
}

test("activity state: reset clears work and compaction completion", () => {
  const activity = createActivityState();
  activity.startChild("first");
  activity.startCompaction();
  activity.finishChild("first");
  activity.startChild("second");
  assert.equal(activity.hasActiveWork(), true);
  activity.reset();
  assert.equal(activity.hasActiveWork(), false);
  assert.equal(activity.mode(), "base");
  assert.equal(activity.finishCompaction(), "base");
});
