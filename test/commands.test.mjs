import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runIgnoredCommand } from "../lib/commands.ts";

function childProcess() {
  const child = new EventEmitter();
  child.unrefCalled = false;
  child.killCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  child.kill = () => { child.killCalled = true; };
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

test("commands: ignored transport rejects promptly when the child stalls", async () => {
  const child = childProcess();
  const started = performance.now();

  await assert.rejects(
    runIgnoredCommand(() => child, "zellij", ["pipe"], { timeoutMs: 50 }),
    /timed out/,
  );

  assert.ok(performance.now() - started < 200);
  assert.equal(child.killCalled, true);
});
