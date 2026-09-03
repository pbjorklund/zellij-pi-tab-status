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
  assert.equal(status.formatWorkingTabName("repo:main", 1), "⠙ repo:main");
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

function restoreZellijEnv(oldZellij) {
  if (oldZellij === undefined) delete process.env.ZELLIJ;
  else process.env.ZELLIJ = oldZellij;
}

function createLifecycleHarness({
  tabActive = false,
  spinnerIntervalMs,
  failRenames = 0,
  seenPollFirstDelayMs,
} = {}) {
  const renames = [];
  const spawnCount = { git: 0, zellij: 0, panes: 0, tabs: 0, renames: 0, renameFailures: 0 };
  let clockMs = 0;
  const handlers = new Map();
  const panes = JSON.stringify([
    {
      id: 248,
      tab_id: 26,
      tab_name: "repo:main",
      pane_command: "pi",
      terminal_command: null,
      pane_cwd: "/repo",
      title: "pi",
      is_focused: true,
      is_plugin: false,
    },
  ]);
  const tabs = () =>
    JSON.stringify([
      { tab_id: 26, name: "repo:main", active: tabActive },
    ]);

  const execFileAsync = async (command, args) => {
    if (command === "git") {
      spawnCount.git += 1;
      const subcommand = args[0];
      if (subcommand === "rev-parse") {
        if (args[1] === "--show-toplevel") return { stdout: "/repo" };
        if (args[1] === "--show-prefix") return { stdout: "" };
        if (args[1] === "--short") return { stdout: "main" };
      }
      if (subcommand === "symbolic-ref") return { stdout: "main" };
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    }
    if (command !== "zellij") throw new Error(`unexpected command: ${command}`);
    spawnCount.zellij += 1;
    const action = args[1];
    if (action === "list-panes") {
      spawnCount.panes += 1;
      return { stdout: panes };
    }
    if (action === "list-tabs") {
      spawnCount.tabs += 1;
      return { stdout: tabs() };
    }
    if (action === "rename-tab-by-id") {
      spawnCount.renames += 1;
      if (spawnCount.renameFailures < failRenames) {
        spawnCount.renameFailures += 1;
        throw new Error("zellij action failed");
      }
      renames.push(args[3]);
      return { stdout: "" };
    }
    throw new Error(`unexpected zellij action: ${action}`);
  };

  const pi = {
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
    events: {
      on(eventName, handler) {
        handlers.set(eventName, handler);
      },
    },
  };

  status.default(pi, {
    execFileAsync,
    spinnerIntervalMs: spinnerIntervalMs ?? 2 ** 30,
    seenPollFirstDelayMs,
    now: () => clockMs,
  });

  const ctx = {
    cwd: "/repo",
    mode: "tui",
    hasUI: true,
  };

  async function fire(eventName, event = {}) {
    const handler = handlers.get(eventName);
    assert.ok(handler, `missing handler for ${eventName}`);
    await handler(event, ctx);
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function publish(eventName, event = {}) {
    const handler = handlers.get(eventName);
    if (handler) await handler(event, ctx);
    await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    fire,
    publish,
    renames,
    hasHandler: (eventName) => handlers.has(eventName),
    spawnCount,
    advanceClock: (ms) => {
      clockMs += ms;
    },
  };
}

test("lifecycle: mid-run threshold compaction keeps the working marker", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, renames } = createLifecycleHarness({ tabActive: false });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");
    assert.match(renames.at(-1), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);

    // PI 0.84.4 can compact between tool calls in the same run: no agent_end,
    // no retry. The run is still active, so the done marker must not appear.
    await fire("session_before_compact", { reason: "threshold", willRetry: false });
    assert.equal(renames.at(-1), "repo:main");

    await fire("session_compact", { reason: "threshold", willRetry: false });
    assert.match(renames.at(-1), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);

    // Only the settled end of the whole run may mark done.
    await fire("agent_settled");
    assert.match(renames.at(-1), /^● repo:main$/);
  } finally {
    if (oldZellij === undefined) delete process.env.ZELLIJ;
    else process.env.ZELLIJ = oldZellij;
  }
});

test("lifecycle: auto-retry and queued follow-up gaps do not mark done", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, publish, renames, hasHandler } = createLifecycleHarness({ tabActive: false });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");

    // agent_end of a low-level run that PI will continue: no done marker.
    assert.equal(hasHandler("agent_end"), false);
    await publish("agent_end", { messages: [], willRetry: true });
    assert.match(renames.at(-1), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);

    await fire("agent_start");
    assert.match(renames.at(-1), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);

    await publish("agent_end", { messages: [], willRetry: false });
    // Still no done marker: settlement decides, and queued follow-ups may exist.
    assert.match(renames.at(-1), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);

    await fire("agent_settled");
    assert.match(renames.at(-1), /^● repo:main$/);
  } finally {
    if (oldZellij === undefined) delete process.env.ZELLIJ;
    else process.env.ZELLIJ = oldZellij;
  }
});

test("lifecycle: failed compaction recovers and does not stay stuck", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, renames } = createLifecycleHarness({ tabActive: false });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");

    await fire("session_before_compact", { reason: "threshold", willRetry: false });
    await fire("session_compact_failed", {
      reason: "threshold",
      errorMessage: "summarization failed",
      aborted: false,
      willRetry: false,
    });
    // Compaction ended with work still active: the working marker must return,
    // and later events must not be blocked by stale compaction state.
    assert.match(renames.at(-1), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);

    // A new run after the failed compaction still animates.
    await fire("agent_settled");
    assert.match(renames.at(-1), /^● repo:main$/);
  } finally {
    if (oldZellij === undefined) delete process.env.ZELLIJ;
    else process.env.ZELLIJ = oldZellij;
  }
});

test("lifecycle: overflow compaction retry keeps work marked until settled", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, publish, renames, hasHandler } = createLifecycleHarness({ tabActive: false });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");

    // Overflow aborts the run, compacts, and retries: agent_end fires between
    // runs, but the session has not settled, so no done marker may appear.
    assert.equal(hasHandler("agent_end"), false);
    await publish("agent_end", { messages: [], willRetry: true });
    await fire("session_before_compact", { reason: "overflow", willRetry: true });
    assert.equal(renames.at(-1), "repo:main");

    await fire("session_compact", { reason: "overflow", willRetry: true });
    assert.match(renames.at(-1), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);

    await fire("agent_start");
    await publish("agent_end", { messages: [], willRetry: false });
    await fire("agent_settled");
    assert.match(renames.at(-1), /^● repo:main$/);
  } finally {
    if (oldZellij === undefined) delete process.env.ZELLIJ;
    else process.env.ZELLIJ = oldZellij;
  }
});

test("lifecycle: active tab restores the base name instead of marking done", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, renames } = createLifecycleHarness({ tabActive: true });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");
    await fire("agent_settled");

    assert.equal(renames.at(-1), "repo:main");
  } finally {
    if (oldZellij === undefined) delete process.env.ZELLIJ;
    else process.env.ZELLIJ = oldZellij;
  }
});

test("lifecycle: working marker animates while work stays active", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, renames } = createLifecycleHarness({ tabActive: false, spinnerIntervalMs: 5 });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");
    const before = renames.at(-1);

    // The spinner timer writes new frames while the parent agent is active.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frames = renames.filter((name) => name !== before);
    assert.ok(frames.length >= 2, `expected spinner frames, got: ${JSON.stringify(renames)}`);

    await fire("agent_settled");
    assert.match(renames.at(-1), /^● repo:main$/);
  } finally {
    if (oldZellij === undefined) delete process.env.ZELLIJ;
    else process.env.ZELLIJ = oldZellij;
  }
});

test("perf: settle within TTL reuses the binding with no panes or git spawns", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, renames, spawnCount, advanceClock } = createLifecycleHarness({ tabActive: false });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");
    const before = { ...spawnCount };

    advanceClock(1_000); // inside both the binding TTL and the title TTL
    await fire("agent_settled");

    assert.equal(spawnCount.panes, before.panes, "no panes re-validation within TTL");
    assert.equal(spawnCount.git, before.git, "no git spawns within title TTL");
    assert.match(renames.at(-1), /^● repo:main$/);
  } finally {
    restoreZellijEnv(oldZellij);
  }
});

test("perf: stale binding re-validates with exactly one panes fetch", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, spawnCount, advanceClock } = createLifecycleHarness({ tabActive: false });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");
    const before = { ...spawnCount };

    advanceClock(6_000); // past the validation TTL
    await fire("agent_settled");

    assert.equal(spawnCount.panes - before.panes, 1, "one panes fetch to re-validate");
    assert.equal(spawnCount.tabs - before.tabs, 2, "active check + name refresh");
  } finally {
    restoreZellijEnv(oldZellij);
  }
});

test("perf: stale title cache refetches git exactly once", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, spawnCount, advanceClock } = createLifecycleHarness({ tabActive: false });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");
    const before = { ...spawnCount };

    advanceClock(31_000); // past the title TTL
    await fire("agent_settled");

    assert.equal(spawnCount.git - before.git, 3, "one title derivation = 3 git spawns");
  } finally {
    restoreZellijEnv(oldZellij);
  }
});

test("perf: failed rename invalidates the binding so the next event rebinds", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, spawnCount } = createLifecycleHarness({ tabActive: false, failRenames: 2 });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");
    assert.equal(spawnCount.renameFailures, 2, "both rename attempts failed");

    await fire("agent_settled");
    assert.ok(
      spawnCount.panes >= 2,
      `expected re-validation spawn, got panes=${spawnCount.panes}`,
    );
  } finally {
    restoreZellijEnv(oldZellij);
  }
});

test("perf: unviewed done tab polls with backoff, not a fixed flood", async (t) => {
  const oldZellij = process.env.ZELLIJ;
  process.env.ZELLIJ = "0";
  try {
    const { fire, spawnCount } = createLifecycleHarness({
      tabActive: false,
      seenPollFirstDelayMs: 5,
    });
    t.after(() => fire("session_shutdown"));

    await fire("session_start");
    await fire("agent_start");
    await fire("agent_settled");
    const afterSettled = spawnCount.tabs;

    // A fixed 5ms interval would fire ~20 polls in 100ms; backoff
    // (5,10,20,40,80) fires 5.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const polls = spawnCount.tabs - afterSettled;
    assert.ok(polls >= 4, `expected the poller to run, saw ${polls}`);
    assert.ok(polls <= 8, `expected backoff, saw ${polls} polls in 100ms`);
  } finally {
    restoreZellijEnv(oldZellij);
  }
});
