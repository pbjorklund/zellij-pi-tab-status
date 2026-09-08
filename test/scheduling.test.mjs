import test from "node:test";
import assert from "node:assert/strict";
import extension from "../pi-extension.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(t, options = {}) {
  const oldEnv = { ZELLIJ: process.env.ZELLIJ, ZELLIJ_PANE_ID: process.env.ZELLIJ_PANE_ID };
  process.env.ZELLIJ = "0";
  process.env.ZELLIJ_PANE_ID = "248";
  t.after(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const handlers = new Map();
  const calls = [];
  const writes = [];
  let tabId = 26;
  let branch = "main";
  let active = false;
  let paneOutput;
  let tabOutput;
  let renameFailures = 0;
  let gate;
  const heldCommands = [];
  const entries = new Map();
  let leaf = null;
  let entryReads = 0;
  const ctx = { cwd: "/repo", mode: "tui", hasUI: true, sessionManager: {
    getLeafId: () => leaf,
    getEntry: (id) => { entryReads++; return entries.get(id); },
  }, ...options.ctx };
  extension({
    on: (name, handler) => handlers.set(name, handler),
    events: { on: (name, handler) => handlers.set(name, handler) },
  }, {
    execFileAsync: async (command, args, execOptions) => {
      calls.push({ command, args, options: execOptions, at: Date.now() });
      if (gate?.matches(command, args)) {
        const current = gate;
        gate = undefined;
        current.entered.resolve();
        await current.release.promise;
      }
      if (command === "git") {
        if (args[1] === "--show-toplevel") return { stdout: "/repo" };
        if (args[1] === "--show-prefix") return { stdout: "" };
        return { stdout: branch };
      }
      if (args[1] === "list-panes") return { stdout: paneOutput ?? JSON.stringify([
        { id: 248, tab_id: tabId, tab_name: "repo:main", pane_cwd: "/repo", pane_command: "pi" },
      ]) };
      if (args[1] === "list-tabs") return { stdout: tabOutput ?? JSON.stringify([
        { tab_id: tabId, name: "repo:main", active },
      ]) };
      assert.equal(args[1], "rename-tab-by-id");
      if (renameFailures > 0) {
        renameFailures--;
        throw new Error("rename failed");
      }
      writes.push({ tabId: args[2], name: args[3] });
      return { stdout: "" };
    },
  });
  const fire = (name, event = {}) => handlers.get(name)?.(event, ctx);
  t.after(async () => {
    for (const held of heldCommands) held.release.resolve();
    await fire("session_shutdown");
  });
  return {
    fire, calls, writes,
    entryReads: () => entryReads,
    appendEntry(entry) {
      const id = `entry-${entries.size}`;
      entries.set(id, { ...entry, id, parentId: leaf });
      leaf = id;
    },
    async start() { fire("session_start"); await flush(); fire("agent_start"); await flush(); },
    async tick(ms) { t.mock.timers.tick(ms); await flush(); },
    setActive(value) { active = value; },
    setBranch(value) { branch = value; },
    moveTo(value) { tabId = value; },
    setPaneOutput(value) { paneOutput = value; },
    setTabOutput(value) { tabOutput = value; },
    failRenames(count) { renameFailures = count; },
    hold(matches) {
      const held = { matches, entered: deferred(), release: deferred() };
      gate = held;
      heldCommands.push(held);
      return held;
    },
  };
}

for (const reason of ["threshold", "overflow", "manual"]) {
  test(`scheduling: ${reason} compaction animates without parent work`, async (t) => {
    const h = harness(t);
    h.fire("session_start");
    h.fire("session_before_compact", { reason, willRetry: false });
    await flush();
    assert.equal(h.writes.at(-1)?.name, "◐ repo:main");
    await h.tick(500);
    assert.equal(h.writes.at(-1)?.name, "◓ repo:main");
    h.fire("session_compact", { reason, willRetry: false });
    await flush();
    assert.equal(h.writes.at(-1)?.name, "repo:main");
    const count = h.calls.length;
    await h.tick(5_000);
    assert.equal(h.calls.length, count);
  });
}

const jobResult = (jobId, state = "queued", toolName = "subagent_spawn") => ({
  toolName, isError: false, result: { details: { jobId, state } },
});
const completion = (jobId, state = "completed") => ({
  type: "custom_message", customType: "pi-subagents-completion", details: { jobId, state },
});

test("scheduling: current subagent jobs animate after parent settlement and finish while idle", async (t) => {
  const h = harness(t);
  await h.start();
  h.fire("tool_execution_end", jobResult("job-one"));
  h.fire("tool_execution_end", jobResult("job-two"));
  h.fire("agent_settled");
  await flush();
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "⠙ repo:main");
  h.appendEntry(completion("job-one"));
  await h.tick(500);
  assert.match(h.writes.at(-1)?.name, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);
  h.appendEntry(completion("job-two"));
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
  const reads = h.entryReads();
  h.appendEntry({ type: "message" });
  await h.tick(5_000);
  assert.equal(h.entryReads(), reads, "no session polling once children finish");
});

test("scheduling: compaction failure restores child-only work", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  h.fire("tool_execution_end", jobResult("job-one"));
  await flush();
  h.fire("session_before_compact", { reason: "threshold" });
  await flush();
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "◓ repo:main");
  h.fire("session_compact_failed", { aborted: true });
  await flush();
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "⠙ repo:main");
});

for (const state of ["completed", "partial", "failed", "timed_out", "cancelled"]) {
  test(`scheduling: current child ${state} completion stops child-only activity`, async (t) => {
    const h = harness(t);
    h.fire("session_start");
    h.fire("tool_execution_end", jobResult("job-one"));
    await flush();
    assert.equal(h.writes.at(-1)?.name, "⠋ repo:main");
    h.appendEntry(completion("job-one", state));
    await h.tick(500);
    assert.equal(h.writes.at(-1)?.name, "● repo:main");
  });
}

test("scheduling: current job tracking ignores errors, unrelated tools, and wait timeouts", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  h.fire("tool_execution_end", { ...jobResult("error"), isError: true });
  h.fire("tool_execution_end", jobResult("unrelated", "queued", "bash"));
  h.fire("tool_execution_end", jobResult("bad", "unknown"));
  await flush();
  assert.deepEqual(h.writes, []);
  h.fire("tool_execution_end", jobResult("job-one"));
  h.fire("tool_execution_end", { ...jobResult("job-one", "running", "subagent_wait"),
    result: { details: { jobId: "job-one", state: "running", timedOut: true } },
  });
  await flush();
  await h.tick(500);
  assert.equal(h.writes.at(-1)?.name, "⠙ repo:main");
  h.fire("tool_execution_end", jobResult("job-one", "cancelled", "subagent_cancel"));
  await flush();
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
});

test("scheduling: malformed legacy events cannot interrupt status handling", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  for (const event of [null, undefined, 1, "job", [], {}, { id: " " }]) {
    h.fire("subagents:started", event);
    h.fire("subagents:completed", event);
    h.fire("subagents:failed", event);
  }
  await flush();
  assert.deepEqual(h.writes, []);
});

test("scheduling: legacy and current subagents can keep the same parent idle", async (t) => {
  const h = harness(t);
  await h.start();
  h.fire("subagents:started", { id: "legacy-child" });
  h.fire("tool_execution_end", jobResult("current-child"));
  h.fire("agent_settled");
  h.appendEntry(completion("current-child"));
  await h.tick(500);
  assert.match(h.writes.at(-1)?.name, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);
  h.fire("subagents:completed", { id: "legacy-child" });
  await flush();
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
});

test("scheduling: job polling reads only the new tail and stops on shutdown", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 100; i++) h.appendEntry({ type: "message" });
  h.fire("session_start");
  h.fire("tool_execution_end", jobResult("job-one"));
  await flush();
  await h.tick(500);
  assert.equal(h.entryReads(), 0);
  h.appendEntry({ type: "message" });
  h.appendEntry({ ...completion("job-one"), customType: "unrelated" });
  await h.tick(500);
  assert.equal(h.entryReads(), 2);
  assert.match(h.writes.at(-1)?.name, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$/);
  await h.tick(500);
  assert.equal(h.entryReads(), 2);
  await h.fire("session_shutdown");
  h.appendEntry(completion("job-one"));
  const count = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.entryReads(), 2);
  assert.equal(h.calls.length, count);
});

test("scheduling: terminal inspect results and duplicate spawn results do not revive jobs", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  h.fire("tool_execution_end", jobResult("job-one"));
  h.fire("tool_execution_end", { toolName: "subagent_inspect", isError: false,
    result: { details: { jobs: [{ jobId: "job-one", state: "completed" }] } },
  });
  h.fire("tool_execution_end", jobResult("job-one"));
  await flush();
  assert.equal(h.writes.at(-1)?.name, "● repo:main");
});

test("scheduling: current completion before spawn result cannot leave a stuck spinner", async (t) => {
  const h = harness(t);
  h.fire("session_start");
  h.appendEntry(completion("fast-job"));
  h.fire("tool_execution_end", jobResult("fast-job"));
  await flush();
  await h.tick(500);
  assert.doesNotMatch(h.writes.at(-1)?.name ?? "", /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

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
