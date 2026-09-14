import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runIgnoredCommand } from "../lib/commands.ts";

function childProcess() {
  const child = new EventEmitter();
  child.unrefCalled = false;
  child.killSignal = null;
  child.unref = () => { child.unrefCalled = true; };
  child.kill = (signal) => { child.killSignal = signal; };
  return child;
}

test("commands: ignored transport resolves without captured streams", async () => {
  const child = childProcess();
  let invocation;
  const completed = runIgnoredCommand((command, args, options) => {
    invocation = { command, args, options };
    return child;
  }, "zellij", ["pipe", "--name", "pi_status", "--", "{}"]);

  child.emit("close", 0, null);
  await completed;

  assert.deepEqual(invocation, {
    command: "zellij",
    args: ["pipe", "--name", "pi_status", "--", "{}"],
    options: { stdio: "ignore", windowsHide: true },
  });
  assert.equal(child.unrefCalled, true);
});

test("commands: ignored transport reports spawn and exit failures", async (t) => {
  await t.test("synchronous spawn failure", async () => {
    await assert.rejects(
      runIgnoredCommand(() => { throw new Error("spawn failed"); }, "zellij", ["pipe"]),
      /spawn failed/,
    );
  });

  await t.test("child process error", async () => {
    const child = childProcess();
    const completed = runIgnoredCommand(() => child, "zellij", ["pipe"]);
    child.emit("error", new Error("unavailable"));
    await assert.rejects(completed, /unavailable/);
  });

  await t.test("nonzero exit", async () => {
    const child = childProcess();
    const completed = runIgnoredCommand(() => child, "zellij", ["pipe"]);
    child.emit("close", 7, null);
    await assert.rejects(completed, /exited with 7/);
  });

  await t.test("signal exit", async () => {
    const child = childProcess();
    const completed = runIgnoredCommand(() => child, "zellij", ["pipe"]);
    child.emit("close", null, "SIGTERM");
    await assert.rejects(completed, /exited with SIGTERM/);
  });
});

test("commands: ignored transport kills a stall and waits for process close", async () => {
  const child = childProcess();
  let settled = false;
  const completed = runIgnoredCommand(
    () => child,
    "zellij",
    ["pipe"],
    { timeoutMs: 20 },
  ).finally(() => { settled = true; });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(child.killSignal, "SIGKILL");
  assert.equal(settled, false);

  child.emit("close", null, "SIGTERM");
  await assert.rejects(completed, /timed out/);
});
