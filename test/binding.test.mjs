import test from "node:test";
import assert from "node:assert/strict";
import { flush, harness } from "./helpers/lifecycle.mjs";

const pane = (tabId, tabName, cwd = "/repo") => JSON.stringify([
  { id: 248, tab_id: tabId, tab_name: tabName, pane_cwd: cwd, pane_command: "pi" },
]);

test("binding: startup replaces a legacy animated title with the static base title", async (t) => {
  const h = harness(t);
  h.setPaneOutput(pane(26, "⠋ repo:main"));
  await h.emit("session_start");
  assert.deepEqual(h.writes, [{ tabId: "26", name: "repo:main" }]);
  await h.emit("agent_start");
  await h.tick(60_000);
  assert.deepEqual(h.writes, [{ tabId: "26", name: "repo:main" }]);
});

test("binding: a transient discovery miss retains a known existing tab", async (t) => {
  const h = harness(t);
  await h.start();
  await h.tick(5_000);
  h.setPaneOutput("[]");
  const before = h.calls.length;
  await h.emit("agent_settled");
  assert.equal(h.calls.slice(before).filter(({ args }) => args[1] === "list-panes").length, 1);
  assert.equal(h.pipes.at(-1)?.mode, "done");
});

test("binding: a failed static rename retries and invalidates the binding", async (t) => {
  const h = harness(t);
  h.setPaneOutput(pane(26, "legacy"));
  h.failRenames(2);
  h.fire("session_start");
  await flush();
  await h.tick(100);
  assert.equal(h.calls.filter(({ args }) => args[1] === "rename-tab-by-id").length, 2);
  assert.deepEqual(h.writes, []);
  await h.emit("agent_start");
  assert.ok(h.calls.filter(({ args }) => args[1] === "list-panes").length >= 2);
});

test("binding: shutdown during initial title lookup cannot acquire or rename a tab", async (t) => {
  const h = harness(t);
  h.setPaneOutput(pane(26, "shell"));
  const held = h.hold((command) => command === "git");
  h.fire("session_start");
  await held.entered.promise;
  const shutdown = h.fire("session_shutdown");
  held.release.resolve();
  await shutdown;
  assert.deepEqual(h.writes, []);
});

test("binding: an expired title refresh writes only the changed static title", async (t) => {
  const h = harness(t);
  await h.start();
  await h.tick(31_000);
  h.setBranch("feature");
  await h.emit("agent_settled");
  assert.equal(h.writes.at(-1)?.name, "repo:feature");
  assert.ok(h.writes.every(({ name }) => !/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒●] /.test(name)));
});

test("binding: a superseding state prevents an obsolete title write", async (t) => {
  const h = harness(t);
  await h.start();
  await h.tick(31_000);
  h.setBranch("feature");
  const held = h.hold((command) => command === "git");
  h.fire("agent_settled");
  await held.entered.promise;
  h.fire("agent_start");
  held.release.resolve();
  await flush();
  assert.equal(h.writes.at(-1)?.name, "repo:feature");
  assert.equal(h.pipes.at(-1)?.mode, "working");
});
