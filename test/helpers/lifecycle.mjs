import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import extension from "../../pi-extension.ts";

export const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

export function harness(t, options = {}) {
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
  const pipes = [];
  let tabId = 26;
  let branch = "main";
  let active = false;
  let paneOutput;
  let tabOutput;
  let renameFailures = 0;
  let pipeFailures = 0;
  let gate;
  const heldCommands = [];
  const entries = new Map();
  let leaf = null;
  let entryReads = 0;
  let abortedCommands = 0;
  const ctx = { cwd: "/repo", mode: "tui", hasUI: true, sessionManager: {
    getLeafId: () => leaf,
    getEntry: (id) => { entryReads++; return entries.get(id); },
  }, ...options.ctx };
  extension({
    on: (name, handler) => handlers.set(name, handler),
    events: { on: (name, handler) => handlers.set(name, handler) },
  }, {
    spinnerIntervalMs: options.spinnerIntervalMs,
    seenPollFirstDelayMs: options.seenPollFirstDelayMs,
    now: options.now,
    runtimeId: options.runtimeId,
    spawnIgnored: (command, args, execOptions) => {
      const child = new EventEmitter();
      child.unref = () => {};
      child.kill = () => {};
      calls.push({ command, args, options: execOptions, at: Date.now() });
      queueMicrotask(async () => {
        if (gate?.matches(command, args)) {
          const current = gate;
          gate = undefined;
          current.entered.resolve();
          await current.release.promise;
        }
        if (pipeFailures > 0) {
          pipeFailures--;
          child.emit("error", new Error("pipe failed"));
          return;
        }
        pipes.push(JSON.parse(args.at(-1)));
        child.emit("close", 0, null);
      });
      return child;
    },
    execFileAsync: async (command, args, execOptions) => {
      calls.push({ command, args, options: execOptions, at: Date.now() });
      if (gate?.matches(command, args)) {
        const current = gate;
        gate = undefined;
        current.entered.resolve();
        await Promise.race([
          current.release.promise,
          new Promise((_, reject) => execOptions.signal?.addEventListener(
            "abort",
            () => {
              abortedCommands++;
              reject(new Error("command aborted"));
            },
            { once: true },
          )),
        ]);
      }
      if (command === "git") {
        if (args[0] === "rev-parse") {
          if (args[1] === "--show-toplevel") return { stdout: "/repo" };
          if (args[1] === "--show-prefix") return { stdout: "" };
          if (args[1] === "--short") return { stdout: branch };
        }
        assert.equal(args[0], "symbolic-ref");
        return { stdout: branch };
      }
      assert.equal(command, "zellij");
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
  const fire = (name, event = {}) => {
    const handler = handlers.get(name);
    assert.ok(handler, `missing handler for ${name}`);
    return handler(event, ctx);
  };
  t.after(async () => {
    for (const held of heldCommands) held.release.resolve();
    await fire("session_shutdown");
  });
  return {
    fire, calls, writes, pipes,
    hasHandler: (name) => handlers.has(name),
    async emit(name, event) { await fire(name, event); await flush(); },
    entryReads: () => entryReads,
    abortedCommands: () => abortedCommands,
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
    failPipes(count) { pipeFailures = count; },
    hold(matches) {
      const held = { matches, entered: deferred(), release: deferred() };
      gate = held;
      heldCommands.push(held);
      return held;
    },
  };
}
