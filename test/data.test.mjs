import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

test("titles: Unicode truncation does not split surrogate pairs", () => {
  assert.equal(status.truncateWithEllipsis("😀😀😀", 2), "😀…");
  assert.equal(status.truncateWithEllipsis("😀😀😀", 1), "…");
  assert.equal(status.truncateWithEllipsis("😀", 2), "😀");
});

test("titles: home and unresolved HEAD fallbacks", async () => {
  const failed = async () => { throw new Error("not a repo"); };
  assert.equal(await status.deriveTabTitle("/home/test/", "/home/test", failed), "~");
  const unresolved = async (_command, args) => {
    if (args[1] === "--show-toplevel") return { stdout: "/repo" };
    if (args[1] === "--show-prefix") return { stdout: "" };
    throw new Error("unresolved HEAD");
  };
  assert.equal(await status.deriveTabTitle("/repo", "/home/test", unresolved), "repo:HEAD");
});

test("titles: real Git unborn branch, detached HEAD, and linked worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "zpts-data-"));
  const repo = join(root, "repo");
  const worktree = join(root, "linked");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    mkdirSync(repo);
    git("init", "-q", "--initial-branch=main");
    assert.equal(await status.deriveTabTitle(repo), "repo:main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "init");
    const sha = git("rev-parse", "--short", "HEAD");
    git("checkout", "-q", "--detach");
    assert.equal(await status.deriveTabTitle(repo), `repo:${sha}`);
    git("worktree", "add", "-qb", "feature", worktree);
    mkdirSync(join(worktree, "nested"));
    assert.equal(await status.deriveTabTitle(join(worktree, "nested")), `${basename(worktree)}/nested:feature`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
