import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createStatusTransport } from "../lib/status-transport.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function controlledSpawner() {
  const children = [];
  const calls = [];
  return {
    children,
    calls,
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.unref = () => {};
      child.kill = () => {};
      children.push(child);
      calls.push({ command, args, options });
      return child;
    },
  };
}

test("status transport serializes lifecycle messages", async () => {
  const process = controlledSpawner();
  const transport = createStatusTransport(process.spawn);
  const snapshot = { v: 1, kind: "snapshot", seq: 1 };
  const remove = { v: 1, kind: "remove", seq: 2 };

  const first = transport.send(snapshot);
  const second = transport.send(remove);
  await flush();
  assert.equal(process.calls.length, 1);
  assert.equal(process.calls[0].args.at(-1), JSON.stringify(snapshot));

  process.children[0].emit("close", 0, null);
  assert.equal(await first, true);
  await flush();
  assert.equal(process.calls.length, 2);
  assert.equal(process.calls[1].args.at(-1), JSON.stringify(remove));

  process.children[1].emit("close", 0, null);
  assert.equal(await second, true);
  await transport.drain();
});

test("status transport continues after a failed delivery", async () => {
  const process = controlledSpawner();
  const transport = createStatusTransport(process.spawn);

  const failed = transport.send({ kind: "snapshot" });
  const recovered = transport.send({ kind: "remove" });
  await flush();
  process.children[0].emit("error", new Error("unavailable"));
  assert.equal(await failed, false);
  await flush();
  process.children[1].emit("close", 0, null);
  assert.equal(await recovered, true);
});
