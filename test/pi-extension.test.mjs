import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers/lifecycle.mjs";

const working = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/;
const count = (h, command, action) => h.calls.filter((call) =>
  call.command === command && (action === undefined || call.args[1] === action)).length;

test("lifecycle: mid-run threshold compaction keeps the working marker", async (t) => {
  const h = harness(t);
  await h.start();
  assert.match(h.writes.at(-1).name, working);
  // Threshold compaction can happen between tool calls, without ending the run.
  await h.emit("session_before_compact", { reason: "threshold", willRetry: false });
  assert.equal(h.writes.at(-1).name, "◐ repo:main");
  await h.emit("session_compact", { reason: "threshold", willRetry: false });
  assert.match(h.writes.at(-1).name, working);
  await h.emit("agent_settled");
  assert.equal(h.writes.at(-1).name, "● repo:main");
});

test("lifecycle: auto-retry and queued follow-up gaps do not mark done", async (t) => {
  const h = harness(t);
  await h.start();
  // Low-level agent_end is deliberately not a completion signal.
  assert.equal(h.hasHandler("agent_end"), false);
  await h.tick(500);
  assert.match(h.writes.at(-1).name, working);
  await h.emit("agent_start");
  await h.tick(500);
  assert.match(h.writes.at(-1).name, working);
  await h.emit("agent_settled");
  assert.equal(h.writes.at(-1).name, "● repo:main");
});

test("lifecycle: failed compaction recovers and does not stay stuck", async (t) => {
  const h = harness(t);
  await h.start();
  await h.emit("session_before_compact", { reason: "threshold", willRetry: false });
  await h.emit("session_compact_failed", {
    reason: "threshold", errorMessage: "summarization failed", aborted: false, willRetry: false,
  });
  assert.match(h.writes.at(-1).name, working);
  await h.emit("agent_settled");
  assert.equal(h.writes.at(-1).name, "● repo:main");
});

test("lifecycle: overflow compaction retry keeps work marked until settled", async (t) => {
  const h = harness(t);
  await h.start();
  assert.equal(h.hasHandler("agent_end"), false);
  await h.emit("session_before_compact", { reason: "overflow", willRetry: true });
  assert.equal(h.writes.at(-1).name, "◐ repo:main");
  await h.emit("session_compact", { reason: "overflow", willRetry: true });
  assert.match(h.writes.at(-1).name, working);
  await h.emit("agent_start");
  await h.emit("agent_settled");
  assert.equal(h.writes.at(-1).name, "● repo:main");
});

test("lifecycle: active tab restores the base name instead of marking done", async (t) => {
  const h = harness(t);
  h.setActive(true);
  await h.start();
  await h.emit("agent_settled");
  assert.equal(h.writes.at(-1).name, "repo:main");
});

test("lifecycle: working marker animates while work stays active", async (t) => {
  const h = harness(t, { spinnerIntervalMs: 5 });
  await h.start();
  const before = h.writes.length;
  for (let i = 0; i < 3; i++) await h.tick(5);
  assert.deepEqual(h.writes.slice(before).map(({ name }) => name), [
    "⠙ repo:main", "⠹ repo:main", "⠸ repo:main",
  ]);
  await h.emit("agent_settled");
  assert.equal(h.writes.at(-1).name, "● repo:main");
});

test("perf: settle within TTL reuses the binding with no panes or git spawns", async (t) => {
  const h = harness(t);
  await h.start();
  const panes = count(h, "zellij", "list-panes");
  const git = count(h, "git");
  await h.tick(1_000);
  await h.emit("agent_settled");
  assert.equal(count(h, "zellij", "list-panes"), panes);
  assert.equal(count(h, "git"), git);
  assert.equal(h.writes.at(-1).name, "● repo:main");
});

test("perf: stale binding re-validates with exactly one panes fetch", async (t) => {
  const h = harness(t);
  await h.start();
  const panes = count(h, "zellij", "list-panes");
  const tabs = count(h, "zellij", "list-tabs");
  await h.tick(6_000);
  await h.emit("agent_settled");
  assert.equal(count(h, "zellij", "list-panes") - panes, 1);
  assert.equal(count(h, "zellij", "list-tabs") - tabs, 2);
});

test("perf: stale title cache refetches git exactly once", async (t) => {
  const h = harness(t);
  await h.start();
  const git = count(h, "git");
  await h.tick(31_000);
  await h.emit("agent_settled");
  assert.equal(count(h, "git") - git, 3);
});

test("perf: failed rename invalidates the binding so the next event rebinds", async (t) => {
  const h = harness(t);
  h.failRenames(2);
  await h.start();
  await h.tick(100);
  assert.equal(count(h, "zellij", "rename-tab-by-id"), 2);
  assert.deepEqual(h.writes, []);
  await h.emit("agent_settled");
  assert.ok(count(h, "zellij", "list-panes") >= 2);
});

test("perf: unviewed done tab polls with backoff, not a fixed flood", async (t) => {
  const h = harness(t, { seenPollFirstDelayMs: 5 });
  await h.start();
  await h.emit("agent_settled");
  const tabs = count(h, "zellij", "list-tabs");
  for (const delay of [5, 10, 20, 40]) await h.tick(delay);
  await h.tick(25);
  assert.equal(count(h, "zellij", "list-tabs") - tabs, 4);
});
