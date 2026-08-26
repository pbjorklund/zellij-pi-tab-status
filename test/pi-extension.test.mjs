import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const status = await import("../pi-extension.ts");

test("stripPiTabPrefix removes working, compacting, and done overlays", () => {
  assert.equal(status.stripPiTabPrefix("⠋ repo/path:branch"), "repo/path:branch");
  assert.equal(status.stripPiTabPrefix("◒ repo/path:branch"), "repo/path:branch");
  assert.equal(status.stripPiTabPrefix("● repo/path:branch"), "repo/path:branch");
  assert.equal(status.stripPiTabPrefix("repo/path:branch"), "repo/path:branch");
});

test("status formatters cycle frames and mark unseen completion", () => {
  assert.equal(status.formatWorkingTabName("repo:main", 0), "⠋ repo:main");
  assert.equal(status.formatWorkingTabName("repo:main", 10), "⠋ repo:main");
  assert.equal(status.formatCompactingTabName("repo:main", 0), "◐ repo:main");
  assert.equal(status.formatDoneTabName("repo:main"), "● repo:main");
});

test("isInteractiveZellij requires TUI mode and Zellij", () => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    assert.equal(status.isInteractiveZellij({ hasUI: true, mode: "tui" }), true);
    assert.equal(status.isInteractiveZellij({ hasUI: true, mode: "rpc" }), false);
    assert.equal(status.isInteractiveZellij({ hasUI: false, mode: "tui" }), false);
    delete process.env.ZELLIJ;
    assert.equal(status.isInteractiveZellij({ hasUI: true, mode: "tui" }), false);
  } finally {
    if (oldZellij === undefined) delete process.env.ZELLIJ;
    else process.env.ZELLIJ = oldZellij;
  }
});

test("parseTabList normalizes ids and ignores malformed rows", () => {
  assert.deepEqual(status.parseTabList(JSON.stringify([
    { tab_id: 26, name: "repo:main", active: true },
    { tab_id: "27", name: "other", active: false },
    { tab_id: null, name: "broken", active: true },
  ])), [
    { tabId: "26", name: "repo:main", active: true },
    { tabId: "27", name: "other", active: false },
  ]);
});

test("parsePaneList resolves terminal and plugin pane metadata", () => {
  assert.deepEqual(status.parsePaneList(JSON.stringify([
    { id: 248, tab_id: 45, tab_name: "repo:main" },
    { id: "249", tab_id: "46", tab_name: "other", is_plugin: true },
    { id: null, tab_id: 47, tab_name: "broken" },
  ])), [
    {
      paneId: "248", tabId: "45", tabName: "repo:main", tabPosition: null,
      paneCommand: null, terminalCommand: null, paneCwd: null, title: null,
      focused: false, plugin: false,
    },
    {
      paneId: "249", tabId: "46", tabName: "other", tabPosition: null,
      paneCommand: null, terminalCommand: null, paneCwd: null, title: null,
      focused: false, plugin: true,
    },
  ]);
});

test("selectOwningPane trusts a matching exported terminal pane", () => {
  const panes = [
    {
      paneId: "0", tabId: "0", tabName: "repo:main", tabPosition: 0,
      paneCommand: "pi", terminalCommand: null, paneCwd: "/repo", title: "π - repo",
      focused: true, plugin: false,
    },
    {
      paneId: "62", tabId: "27", tabName: "repo:main", tabPosition: 26,
      paneCommand: "pi", terminalCommand: null, paneCwd: "/repo", title: "π - repo",
      focused: true, plugin: false,
    },
  ];
  const tabs = [
    { tabId: "0", name: "repo:main", active: false },
    { tabId: "27", name: "repo:main", active: true },
  ];

  assert.equal(status.selectOwningPane(panes, tabs, "/repo", "0")?.paneId, "0");
});

test("selectOwningPane ignores plugin collisions and different cwd tabs", () => {
  const pluginCollision = {
    paneId: "49", tabId: "9", tabName: "plugin", tabPosition: 9,
    paneCommand: null, terminalCommand: null, paneCwd: null,
    title: "file:/tmp/zellij-tabbar.wasm", focused: false, plugin: true,
  };
  const owner = {
    paneId: "49", tabId: "3", tabName: "repo", tabPosition: 3,
    paneCommand: "pi", terminalCommand: "bash -ilc pi -c", paneCwd: "/repo",
    title: "pi", focused: true, plugin: false,
  };

  assert.equal(status.selectOwningPane([pluginCollision, owner], [{ tabId: "3", name: "repo", active: true }], "/repo", "49")?.tabId, "3");
  assert.equal(status.selectOwningPane([owner], [{ tabId: "3", name: "repo", active: true }], "/elsewhere", undefined), null);
});

test("work tracker remains active until parent and subagents finish", () => {
  const tracker = status.createWorkTracker();
  tracker.startParentAgent();
  tracker.startSubagent({ id: "agent-1" });
  tracker.endParentAgent();
  assert.equal(tracker.hasActiveWork(), true);
  tracker.endSubagent({ id: "agent-1" });
  assert.equal(tracker.hasActiveWork(), false);
});

test("formatGitTabTitle keeps the branch and truncates long paths", () => {
  assert.equal(status.formatGitTabTitle("repo/path", "feature", 40), "repo/path:feature");
  const title = status.formatGitTabTitle("very-long-repository/very-long-subdirectory", "feature/extremely-long-branch", 40);
  assert.equal([...title].length <= 40, true);
  assert.match(title, /…:feature\/extrem…$/);
});

test("deriveTabTitle uses repo path and branch without an external helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "zpts-"));
  try {
    execFileSync("git", ["init", "-q", "--initial-branch=main", root]);
    execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "init"]);
    execFileSync("git", ["-C", root, "switch", "-q", "-c", "feature/tab-status"]);
    mkdirSync(join(root, "nested"));

    assert.equal(await status.deriveTabTitle(join(root, "nested")), `${root.split("/").at(-1)}/nested:feature/tab-status`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveTabTitle falls back to a directory name outside git", async () => {
  const root = mkdtempSync(join(tmpdir(), "zellij-title-dir-"));
  try {
    assert.equal(await status.deriveTabTitle(root), root.split("/").at(-1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
