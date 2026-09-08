import test from "node:test";
import assert from "node:assert/strict";
import * as status from "../pi-extension.ts";
import { readOwningTabWith, readTabByIdWith } from "../lib/zellij.ts";
import { runCommand } from "../lib/commands.ts";

const pane = (values = {}) => ({
  paneId: "1", tabId: "10", tabName: "repo", paneCwd: "/repo",
  paneCommand: null, terminalCommand: null, title: null,
  focused: false, plugin: false, tabPosition: 0, ...values,
});

test("ownership: fallback prefers the active matching tab over a stale exported id", () => {
  const stale = pane({ paneId: "3", paneCwd: "/other" });
  const background = pane({ paneId: "2", paneCommand: "pi" });
  const active = pane({ paneId: "4", tabId: "11" });
  const tabs = [{ tabId: "11", name: "active", active: true }];
  assert.equal(status.selectOwningPane([stale, background, active], tabs, "/repo/", "3"), active);
});

test("ownership: PI command signals break ties within a matching tab", () => {
  for (const signal of [{ paneCommand: "pi -c" }, { terminalCommand: "bash -c pi" }, { title: "π - repo" }]) {
    const piPane = pane({ paneId: "2", ...signal });
    assert.equal(status.selectOwningPane([pane(), piPane], [], "/repo", undefined), piPane);
  }
  assert.equal(status.selectOwningPane([pane({ plugin: true })], [], "/repo", "1"), null);
});

test("ownership: equal scores preserve input order and a matching exported id wins", () => {
  const first = pane();
  const second = pane({ paneId: "2" });
  assert.equal(status.selectOwningPane([first, second], [], "/repo", undefined), first);
  assert.equal(status.selectOwningPane([first, second], [], "/repo", "2"), second);
});

test("parsers: non-array lists and malformed rows cannot become tab bindings", () => {
  for (const value of [null, 1, "pane", [], {}, { tab_id: 1 }, { id: {}, tab_id: 1, tab_name: "repo" }]) {
    assert.equal(status.parsePaneInfo(value), null);
    assert.equal(status.parseTabInfo(value), null);
  }
  for (const text of ["null", "{}", "42"]) {
    assert.deepEqual(status.parsePaneList(text), []);
    assert.deepEqual(status.parseTabList(text), []);
  }
  assert.throws(() => status.parseTabList("not json"), SyntaxError);
  assert.throws(() => status.parsePaneList("not json"), SyntaxError);
});

test("parsers: pane metadata preserves string ids and optional owner signals", () => {
  assert.deepEqual(status.parsePaneInfo({
    id: "pane-1", tab_id: "tab-2", tab_name: "work",
    tab_position: 3, pane_command: "pi -c", terminal_command: "bash -c pi",
    pane_cwd: "/repo", title: "π work", is_focused: true, is_plugin: false,
  }), {
    paneId: "pane-1", tabId: "tab-2", tabName: "work",
    tabPosition: 3, paneCommand: "pi -c", terminalCommand: "bash -c pi",
    paneCwd: "/repo", title: "π work", focused: true, plugin: false,
  });
});

test("parsers: invalid tab identity cannot hide behind a valid pane id", () => {
  for (const row of [
    { id: 1, tab_id: {}, tab_name: "repo" },
    { id: 1, tab_id: 2, tab_name: false },
  ]) {
    assert.equal(status.parsePaneInfo(row), null);
  }
});

test("ownership: focus breaks a tie before tab position", () => {
  const later = pane({ paneId: "2", tabPosition: 5 });
  const focused = pane({ focused: true, tabPosition: null });
  assert.equal(status.selectOwningPane([later, focused], [], "/repo", undefined), focused);
});

test("ownership: later tab position breaks an otherwise equal score", () => {
  const later = pane({ paneId: "2", tabPosition: 1 });
  assert.equal(status.selectOwningPane([pane({ tabPosition: null }), later], [], "/repo", undefined), later);
});

test("ownership: a plain PI title identifies work without command metadata", () => {
  const piPane = pane({ paneId: "2", title: "pi" });
  assert.equal(status.selectOwningPane([pane(), piPane], [], "/repo", undefined), piPane);
});

test("ownership: missing cwd does not match the filesystem root", () => {
  const root = pane({ paneId: "2", paneCwd: "///" });
  assert.equal(status.selectOwningPane([pane({ paneCwd: null }), root], [], "/", undefined), root);
  assert.equal(status.selectOwningPane([pane({ paneCwd: "" })], [], "/", undefined), null);
});

test("ownership reads: malformed output and command failures remain best effort", async () => {
  for (const exec of [async () => { throw new Error("unavailable"); }, async () => ({ stdout: "not json" })]) {
    assert.equal(await readTabByIdWith(exec, "1"), null);
    assert.equal(await readOwningTabWith(exec, { cwd: "/repo" }), null);
  }
});

test("ownership reads: pane metadata still binds when tab listing fails", async () => {
  const exec = async (_command, args) => {
    if (args[1] === "list-tabs") throw new Error("unavailable");
    return { stdout: JSON.stringify([{ id: 1, tab_id: 10, tab_name: "repo", pane_cwd: "/repo" }]) };
  };
  assert.deepEqual(await readOwningTabWith(exec, { cwd: "/repo" }), {
    tabId: "10", name: "repo", paneCwd: "/repo", active: false,
  });
});

test("commands: titles remain literal argv with bounded execution", async () => {
  let call;
  const name = "repo:$(touch /tmp/not-executed); echo 'hello'";
  await runCommand(async (...args) => { call = args; return { stdout: "" }; }, "zellij", ["action", "rename-tab-by-id", "26", name]);
  assert.deepEqual(call, ["zellij", ["action", "rename-tab-by-id", "26", name], {
    cwd: undefined, timeout: 2_000, windowsHide: true, maxBuffer: 1024 * 1024,
  }]);
});

test("work tracker: duplicate starts, unknown ends, invalid ids, and reset", () => {
  const work = status.createWorkTracker();
  for (const id of [undefined, null, 2, "", "  "]) work.startSubagent({ id });
  assert.equal(work.hasActiveWork(), false);
  work.startSubagent({ id: "one" });
  work.startSubagent({ id: "one" });
  work.endSubagent({ id: "unknown" });
  assert.equal(work.activeSubagentCount(), 1);
  work.startParentAgent();
  work.reset();
  assert.equal(work.hasActiveWork(), false);
  assert.equal(work.activeSubagentCount(), 0);
});

test("markers: detection and stripping round-trip every animation frame", () => {
  for (let frame = 0; frame < 20; frame++) {
    const working = status.formatWorkingTabName("repo:main", frame);
    const compacting = status.formatCompactingTabName("repo:main", frame);
    assert.equal(status.isWorkingTabName(working), true);
    assert.equal(status.isCompactingTabName(compacting), true);
    assert.equal(status.stripPiTabPrefix(`  ${working}`), "repo:main");
    assert.equal(status.stripPiTabPrefix(compacting), "repo:main");
  }
  assert.equal(status.isWorkingTabName("● repo:main"), false);
  assert.equal(status.isCompactingTabName("repo:main"), false);
});
