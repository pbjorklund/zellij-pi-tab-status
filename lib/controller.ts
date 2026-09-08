import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TabMode } from "./activity.ts";
export type { TabMode } from "./activity.ts";
import { defaultExecFileAsync, type ExecFileAsyncFn } from "./commands.ts";
import { createTabWriter, readTabByIdWith } from "./zellij.ts";
import { createTabBinding } from "./tab-binding.ts";
import { formatCompactingTabName, formatDoneTabName, formatWorkingTabName, isInteractiveZellij } from "./status-model.ts";

const RETRY_DELAY_MS = 100;
const SEEN_POLL_MAX_DELAY_MS = 2_000;

export type ZellijTabStatusOptions = {
  execFileAsync?: ExecFileAsyncFn;
  spinnerIntervalMs?: number;
  seenPollFirstDelayMs?: number;
  now?: () => number;
};

type Target = { ctx: ExtensionContext; mode: TabMode };
type Update = "event" | "frame" | "poll";

export function createTabStatusController(options: ZellijTabStatusOptions = {}) {
  const exec = options.execFileAsync ?? defaultExecFileAsync;
  const now = options.now ?? Date.now;
  const spinnerIntervalMs = options.spinnerIntervalMs ?? 500;
  const firstPollDelayMs = options.seenPollFirstDelayMs ?? 250;
  let target: Target | null = null;
  const writer = createTabWriter(exec, retryDelay);
  const bindings = createTabBinding(exec, now, retryDelay, writer.release);
  let worker: Promise<void> | null = null;
  let pending: Update | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelRetry: (() => void) | null = null;
  let closing = false;
  let shutdown: Promise<void> | null = null;
  let frame = 0;
  let pollDelayMs = firstPollDelayMs;

  const current = (snapshot: Target) => !closing && target === snapshot;

  function stopTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

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

  async function render(snapshot: Target, update: Update) {
    if (update === "event") {
      const bound = await bindings.ensure(snapshot.ctx, () => current(snapshot));
      if (!bound || !current(snapshot)) return;
      const baseName = await bindings.title(bound.cwd);
      if (!current(snapshot)) return;
      bound.baseName = baseName;
    }
    const bound = bindings.current();
    if (!bound || !current(snapshot)) return;
    let name = bound.baseName;
    if (snapshot.mode === "working") {
      name = formatWorkingTabName(bound.baseName, frame++);
    } else if (snapshot.mode === "compacting") {
      name = formatCompactingTabName(bound.baseName, frame++);
    } else if (snapshot.mode === "done") {
      const tab = await readTabByIdWith(exec, bound.tabId);
      if (!current(snapshot)) return;
      if (tab?.active) {
        const baseName = await bindings.title(bound.cwd);
        if (!current(snapshot)) return;
        bound.baseName = name = baseName;
        target = { ...snapshot, mode: "base" };
        snapshot = target;
      } else {
        name = formatDoneTabName(bound.baseName);
        if (update === "poll") pollDelayMs = Math.min(pollDelayMs * 2, SEEN_POLL_MAX_DELAY_MS);
      }
    }
    await writer.rename(bound, name, () => current(snapshot));
  }

  function scheduleNext() {
    if (closing || !bindings.current() || !target || timer !== null) return;
    const animated = target.mode === "working" || target.mode === "compacting";
    const update = animated ? "frame" : target.mode === "done" ? "poll" : null;
    if (!update) return;
    timer = setTimeout(() => {
      timer = null;
      request(update);
    }, update === "frame" ? spinnerIntervalMs : pollDelayMs);
    timer.unref?.();
  }

  function request(update: Update) {
    if (closing) return;
    pending = update;
    if (worker) return;
    // Defer the drain so a burst of lifecycle events becomes one latest-state
    // update, rather than a queue of stale tab commands that blocks PI.
    worker = Promise.resolve().then(async () => {
      while (pending && target && !closing) {
        const next = pending;
        pending = null;
        await render(target, next);
      }
    }).catch(() => {
      // Status is best effort, including unexpected adapter failures.
    }).finally(() => {
      worker = null;
      if (pending && !closing) request(pending);
      else scheduleNext();
    });
  }

  return {
    setMode(ctx: ExtensionContext, mode: TabMode) {
      if (closing || !isInteractiveZellij(ctx)) return;
      if (target?.mode === mode && target.ctx.cwd === ctx.cwd) {
        if ((worker && !bindings.current()) || bindings.isFresh()) return;
      }
      target = { ctx, mode };
      stopTimer();
      cancelRetry?.();
      frame = 0;
      pollDelayMs = firstPollDelayMs;
      request("event");
    },
    clearDone(ctx: ExtensionContext) {
      if (target?.mode === "done") this.setMode(ctx, "base");
    },
    close(): Promise<void> {
      if (shutdown) return shutdown;
      closing = true;
      pending = null;
      stopTimer();
      cancelRetry?.();
      shutdown = (async () => {
        await worker;
        // Do not discover tabs or refresh Git during teardown. Finish any
        // issued write, then restore only the binding this instance owned.
        const bound = bindings.current();
        if (bound) await writer.rename(bound, bound.baseName, () => true);
        bindings.clear();
        target = null;
      })();
      return shutdown;
    },
  };
}
