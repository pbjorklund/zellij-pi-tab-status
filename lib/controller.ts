import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TabMode } from "./activity.ts";
export type { TabMode } from "./activity.ts";
import { defaultExecFileAsync, runCommand, type ExecFileAsyncFn } from "./commands.ts";
import { createTabWriter, readTabByIdWith } from "./zellij.ts";
import { createTabBinding } from "./tab-binding.ts";
import { isInteractiveZellij } from "./status-model.ts";

const RETRY_DELAY_MS = 100;

export type ZellijTabStatusOptions = {
  execFileAsync?: ExecFileAsyncFn;
  now?: () => number;
  runtimeId?: string;
  // Retained for callers that configured the former title-animation controller.
  spinnerIntervalMs?: number;
  seenPollFirstDelayMs?: number;
};

type Target = { ctx: ExtensionContext; mode: TabMode };

export function createTabStatusController(options: ZellijTabStatusOptions = {}) {
  const exec = options.execFileAsync ?? defaultExecFileAsync;
  const now = options.now ?? Date.now;
  const runtimeId = options.runtimeId ?? randomUUID();
  const firstPollDelayMs = options.seenPollFirstDelayMs ?? 250;
  const writer = createTabWriter(exec, retryDelay);
  const bindings = createTabBinding(exec, now, retryDelay);
  let target: Target | null = null;
  let worker: Promise<void> | null = null;
  let pending: Target | null = null;
  let cancelRetry: (() => void) | null = null;
  let seenTimer: ReturnType<typeof setTimeout> | null = null;
  let pollDelayMs = firstPollDelayMs;
  let closing = false;
  let shutdown: Promise<void> | null = null;
  let seq = 0;
  let published = false;

  const paneId = () => {
    const value = Number(process.env.ZELLIJ_PANE_ID);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };

  function retryDelay() {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(finish, RETRY_DELAY_MS);
      function finish() {
        clearTimeout(timeout);
        cancelRetry = null;
        resolve();
      }
      cancelRetry = finish;
    });
  }

  function stopSeenTimer() {
    if (seenTimer !== null) clearTimeout(seenTimer);
    seenTimer = null;
  }

  async function send(message: Record<string, unknown>) {
    try {
      await runCommand(exec, "zellij", [
        "pipe", "--name", "pi_status", "--", JSON.stringify(message),
      ]);
    } catch {
      // Status is best effort. A later lifecycle transition repairs the snapshot.
    }
  }

  async function publish(snapshot: Target) {
    const id = paneId();
    if (id === null || !isInteractiveZellij(snapshot.ctx)) return;
    published = true;
    await send({
      v: 1,
      kind: "snapshot",
      runtime_id: runtimeId,
      seq: ++seq,
      pane_id: id,
      mode: snapshot.mode,
    });
  }

  async function refreshStaticTitle(snapshot: Target) {
    const current = () => !closing && target === snapshot;
    const bound = await bindings.ensure(snapshot.ctx, current);
    if (!bound || !current()) return;
    const baseName = await bindings.title(bound.cwd);
    if (!current()) return;
    bound.baseName = baseName;
    await writer.rename(bound, baseName, current);
  }

  function request(snapshot: Target) {
    pending = snapshot;
    if (worker) return;
    worker = Promise.resolve().then(async () => {
      while (pending && !closing) {
        const next = pending;
        pending = null;
        await publish(next);
        await refreshStaticTitle(next);
      }
    }).catch(() => {
      // Lifecycle hooks must not fail because status or title updates failed.
    }).finally(() => {
      worker = null;
      if (pending && !closing) request(pending);
      else scheduleSeenPoll();
    });
  }

  function scheduleSeenPoll() {
    if (closing || seenTimer !== null || target?.mode !== "done") return;
    const snapshot = target;
    seenTimer = setTimeout(async () => {
      seenTimer = null;
      const bound = bindings.current();
      const tab = bound ? await readTabByIdWith(exec, bound.tabId) : null;
      if (closing || target !== snapshot) return;
      if (tab?.active) {
        setMode(snapshot.ctx, "base");
      } else {
        pollDelayMs = Math.min(pollDelayMs * 2, 2_000);
        scheduleSeenPoll();
      }
    }, pollDelayMs);
    seenTimer.unref?.();
  }

  function setMode(ctx: ExtensionContext, mode: TabMode) {
    if (closing || !isInteractiveZellij(ctx)) return;
    if (target?.mode === mode && target.ctx.cwd === ctx.cwd) return;
    target = { ctx, mode };
    stopSeenTimer();
    pollDelayMs = firstPollDelayMs;
    cancelRetry?.();
    request(target);
  }

  return {
    setMode,
    clearDone(ctx: ExtensionContext) {
      if (target?.mode === "done") setMode(ctx, "base");
    },
    close(): Promise<void> {
      if (shutdown) return shutdown;
      closing = true;
      pending = null;
      stopSeenTimer();
      cancelRetry?.();
      shutdown = (async () => {
        await worker;
        const id = paneId();
        if (published && id !== null) {
          await send({
            v: 1,
            kind: "remove",
            runtime_id: runtimeId,
            seq: ++seq,
            pane_id: id,
          });
        }
        bindings.clear();
        target = null;
      })();
      return shutdown;
    },
  };
}
