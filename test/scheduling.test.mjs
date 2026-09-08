import test from "node:test";
import assert from "node:assert/strict";
import { flush, harness } from "./helpers/lifecycle.mjs";

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
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
});

test("scheduling: 100 subagent starts add no commands while already working", async (t) => {
  const h = harness(t);
  await h.start();
  const before = h.calls.length;
  for (let i = 0; i < 100; i++) h.fire("subagents:started", { id: `child-${i}` });
  await flush();
  assert.equal(h.calls.length - before, 0);
  h.fire("agent_settled");
  for (let i = 0; i < 99; i++) h.fire("subagents:completed", { id: `child-${i}` });
  await flush();
  assert.notEqual(h.writes.at(-1)?.name, "● repo:main");
  h.fire("subagents:failed", { id: "child-99" });
  await flush();
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
});

test("scheduling: shutdown during initial bind cannot write or restart timers", async (t) => {
  const h = harness(t);
  const held = h.hold((command) => command === "zellij");
  h.fire("session_start");
  await held.entered.promise;
  const shutdown = h.fire("session_shutdown");
  held.release.resolve();
  await shutdown;
  await flush();
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, count);
  assert.equal(h.calls.filter(({ command }) => command === "git").length, 0);
  assert.deepEqual(h.writes, []);
});

test("scheduling: slow spinner writes leave a full interval before the next frame", async (t) => {
  const h = harness(t);
  await h.start();
  const held = h.hold((_command, args) => args[1] === "rename-tab-by-id");
  await h.tick(500);
  await held.entered.promise;
  await h.tick(10_000);
  const writesBeforeRelease = h.writes.length;
  held.release.resolve();
  await flush();
  assert.equal(h.writes.length, writesBeforeRelease + 1, "no catch-up frame after a slow command");
  const before = h.calls.length;
  await h.tick(499);
  assert.equal(h.calls.length, before);
  await h.tick(1);
  assert.equal(h.calls.length, before + 1);
});

test("scheduling: a stale seen poll cannot erase new work", async (t) => {
  const h = harness(t);
  await h.start();
  h.fire("agent_settled");
  await flush();
  const held = h.hold((_command, args) => args[1] === "list-tabs");
  await h.tick(250);
  await held.entered.promise;
  h.setActive(true);
  h.fire("agent_start");
  held.release.resolve();
  await flush();
  assert.match(h.writes.at(-1)?.name, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);
  const before = h.writes.length;
  await h.tick(500);
  assert.equal(h.writes.length, before + 1);
});

test("scheduling: shutdown restores base after an in-flight spinner write", async (t) => {
  const h = harness(t);
  await h.start();
  const held = h.hold((_command, args) => args[1] === "rename-tab-by-id");
  await h.tick(500);
  await held.entered.promise;
  const shutdown = h.fire("session_shutdown");
  held.release.resolve();
  await shutdown;
  await flush();
  assert.equal(h.writes.at(-1)?.name, "repo:main");
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, count);
});

test("scheduling: sequential subagent events preserve the spinner deadline", async (t) => {
  const h = harness(t);
  await h.start();
  const count = h.calls.length;
  for (let i = 0; i < 100; i++) {
    h.fire("subagents:started", { id: `child-${i}` });
    await flush();
  }
  assert.equal(h.calls.length, count);
  await h.tick(499);
  assert.equal(h.calls.length, count);
  await h.tick(1);
  assert.equal(h.calls.length, count + 1);
  assert.equal(h.writes.at(-1)?.name, "⠙ repo:main");
});

test("scheduling: unseen polling doubles to a two-second cap then stops when viewed", async (t) => {
  const h = harness(t);
  await h.start();
  h.fire("agent_settled");
  await flush();
  for (const delay of [250, 500, 1_000, 2_000, 2_000]) {
    const count = h.calls.length;
    await h.tick(delay - 1);
    assert.equal(h.calls.length, count);
    await h.tick(1);
    assert.equal(h.calls.length, count + 1);
    assert.equal(h.calls.at(-1).args[1], "list-tabs");
  }
  h.setActive(true);
  await h.tick(2_000);
  assert.equal(h.writes.at(-1)?.name, "repo:main");
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, count);
});

test("scheduling: interactive input clears done but extension input does not", async (t) => {
  const h = harness(t);
  await h.start();
  h.fire("agent_settled");
  await flush();
  h.fire("input", { source: "extension" });
  await flush();
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
  h.fire("input", { source: "interactive" });
  await flush();
  assert.equal(h.writes.at(-1)?.name, "repo:main");
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, count);
});

test("scheduling: moving a pane restores its old owned overlay", async (t) => {
  const h = harness(t);
  await h.start();
  await h.tick(5_000);
  h.setTabOutput(JSON.stringify([
    { tab_id: 26, name: h.writes.at(-1).name, active: false },
    { tab_id: 27, name: "repo:main", active: false },
  ]));
  h.moveTo(27);
  const before = h.writes.length;
  h.fire("agent_settled");
  await flush();
  assert.deepEqual(h.writes.slice(before), [
    { tabId: "26", name: "repo:main" },
    { tabId: "27", name: "● repo:main" },
  ]);
});

for (const previous of [[], [{ tab_id: 26, name: "another owner", active: false }]]) {
  test(`scheduling: rebinding leaves ${previous.length ? "externally renamed" : "missing"} tabs alone`, async (t) => {
    const h = harness(t);
    await h.start();
    await h.tick(5_000);
    h.setTabOutput(JSON.stringify([...previous, { tab_id: 27, name: "repo:main", active: false }]));
    h.moveTo(27);
    const before = h.writes.length;
    h.fire("agent_settled");
    await flush();
    assert.deepEqual(h.writes.slice(before), [{ tabId: "27", name: "● repo:main" }]);
  });
}

test("scheduling: expired binding follows a moved pane", async (t) => {
  const h = harness(t);
  await h.start();
  await h.tick(5_000);
  h.moveTo(27);
  const before = h.writes.length;
  h.fire("agent_settled");
  await flush();
  assert.deepEqual(h.writes.slice(before), [{ tabId: "27", name: "● repo:main" }]);
});

test("scheduling: same-mode events refresh expired bindings and titles", async (t) => {
  const h = harness(t);
  await h.start();
  await h.tick(5_000);
  h.moveTo(27);
  h.fire("subagents:started", { id: "first" });
  await flush();
  assert.equal(h.writes.at(-1)?.tabId, "27");
  await h.tick(25_000);
  h.setBranch("feature");
  h.fire("subagents:started", { id: "second" });
  await flush();
  assert.match(h.writes.at(-1)?.name, / repo:feature$/);
});

test("scheduling: same-mode rebind survives an in-flight expired spinner frame", async (t) => {
  const h = harness(t);
  await h.start();
  const held = h.hold((_command, args) => args[1] === "rename-tab-by-id");
  await h.tick(5_000);
  h.moveTo(27);
  h.fire("subagents:started", { id: "child" });
  held.release.resolve();
  await flush();
  assert.equal(h.writes.at(-1)?.tabId, "27");
});

test("scheduling: viewing a done tab refreshes an expired title", async (t) => {
  const h = harness(t);
  await h.start();
  h.fire("agent_settled");
  await flush();
  await h.tick(30_000);
  h.setBranch("feature");
  h.setActive(true);
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "repo:feature");
});

test("scheduling: new work supersedes a stalled seen-title refresh", async (t) => {
  const h = harness(t);
  await h.start();
  h.fire("agent_settled");
  await flush();
  await h.tick(30_000);
  h.setActive(true);
  const held = h.hold((command) => command === "git");
  await h.tick(500);
  assert.ok(h.calls.some(({ command, at }) => command === "git" && at === 30_500));
  h.fire("agent_start");
  held.release.resolve();
  await flush();
  assert.match(h.writes.at(-1)?.name, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);
});

test("scheduling: shutdown cancels bind retry sleep", async (t) => {
  const h = harness(t);
  h.setPaneOutput("not json");
  h.fire("session_start");
  await flush();
  await h.fire("session_shutdown");
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, count);
  assert.deepEqual(h.writes, []);
});

test("scheduling: no timer survives a disappeared tab after bounded bind retries", async (t) => {
  const h = harness(t);
  await h.start();
  await h.tick(5_000);
  h.setPaneOutput("[]");
  h.setTabOutput("[]");
  h.fire("agent_settled");
  await flush();
  for (let i = 0; i < 19; i++) await h.tick(100);
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, count);
});

test("scheduling: same-mode lifecycle retries a failed write", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  await flush();
  h.failRenames(2);
  h.fire("agent_start");
  await flush();
  await h.tick(100);
  assert.deepEqual(h.writes, []);
  h.fire("agent_start");
  await flush();
  assert.equal(h.writes.at(-1)?.name, "⠋ repo:main");
});

test("scheduling: settled state replaces a failed spinner retry", async (t) => {
  const h = harness(t);
  await h.start();
  h.failRenames(1);
  await h.tick(500);
  const before = h.writes.length;
  h.fire("agent_settled");
  await flush();
  assert.deepEqual(h.writes.slice(before), [{ tabId: "26", name: "● repo:main" }]);
});

test("scheduling: duplicate and unknown child completions cannot mark idle work done", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  await flush();
  for (const data of [{}, { id: "" }, { id: "unknown" }]) h.fire("subagents:completed", data);
  await flush();
  assert.deepEqual(h.writes, []);
  h.fire("subagents:started", { id: "child" });
  h.fire("subagents:started", { id: "child" });
  await flush();
  h.fire("subagents:completed", { id: "child" });
  await flush();
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
  const count = h.calls.length;
  h.fire("subagents:failed", { id: "child" });
  await flush();
  assert.equal(h.calls.length, count);
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
