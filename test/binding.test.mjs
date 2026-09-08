import test from "node:test";
import assert from "node:assert/strict";
import { flush, harness } from "./helpers/lifecycle.mjs";

const pane = (tabId, tabName, cwd = "/repo") => JSON.stringify([
  { id: 248, tab_id: tabId, tab_name: tabName, pane_cwd: cwd, pane_command: "pi" },
]);

test("binding: transient pane discovery failure retains a known existing tab", async (t) => {
  const h = harness(t);
  await h.start();
  await h.tick(5_000);
  h.setPaneOutput("[]");
  const before = h.calls.length;
  await h.emit("agent_settled");
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
  assert.equal(h.calls.slice(before).filter(({ args }) => args[1] === "list-panes").length, 1);
  assert.equal(h.calls.slice(before).filter(({ command }) => command === "git").length, 0);

  const afterSettle = h.calls.length;
  await h.emit("agent_start");
  assert.deepEqual(h.calls.slice(afterSettle).map(({ args }) => args[1]), ["rename-tab-by-id"],
    "the retained binding is fresh, so new work does not rediscover its pane");
  assert.equal(h.writes.at(-1)?.name, "⠋ repo:main");
});

test("binding: shutdown during initial title lookup cannot acquire a tab", async (t) => {
  const h = harness(t);
  h.setPaneOutput(pane(26, "shell"));
  const held = h.hold((command) => command === "git");
  h.fire("session_start");
  await held.entered.promise;
  const shutdown = h.fire("session_shutdown");
  held.release.resolve();
  await shutdown;
  assert.deepEqual(h.writes, [], "the tab was never acquired and its shell title must survive");
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, count);
});

test("binding: shutdown while releasing a moved pane cannot acquire its new tab", async (t) => {
  const h = harness(t);
  await h.start();
  await h.tick(5_000);
  h.setTabOutput(JSON.stringify([
    { tab_id: 26, name: h.writes.at(-1).name, active: false },
    { tab_id: 27, name: "new tab", active: false },
  ]));
  h.setPaneOutput(pane(27, "new tab"));
  const before = h.writes.length;
  const held = h.hold((_command, args) => args[1] === "rename-tab-by-id");
  h.fire("agent_settled");
  await held.entered.promise;
  const shutdown = h.fire("session_shutdown");
  held.release.resolve();
  await shutdown;
  assert.deepEqual(h.writes.slice(before), [{ tabId: "26", name: "repo:main" }],
    "only the old owned overlay may be restored during shutdown");
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, count);
});

test("binding: new work supersedes an expired event title lookup", async (t) => {
  const h = harness(t);
  await h.start();
  await h.tick(30_000);
  h.setBranch("feature");
  const held = h.hold((command) => command === "git");
  const before = h.writes.length;
  h.fire("agent_settled");
  await held.entered.promise;
  h.fire("agent_start");
  held.release.resolve();
  await flush();
  assert.deepEqual(h.writes.slice(before), [{ tabId: "26", name: "⠋ repo:feature" }],
    "the obsolete settled update must not flash a done marker");
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "⠙ repo:feature");
});
