import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultExecFileAsync, runCommand, type ExecFileAsyncFn } from "./commands.ts";
import { pathsMatch, readOwningTabWith, readTabByIdWith } from "./ownership.ts";
import { deriveTabTitle } from "./tab-title.ts";
import { formatDoneTabName, formatWorkingTabName, isInteractiveZellij } from "./status-model.ts";

const VALIDATION_TTL_MS = 5_000;
const TITLE_CACHE_TTL_MS = 30_000;
const BIND_RETRY_ATTEMPTS = 20;
const RETRY_DELAY_MS = 100;
const SEEN_POLL_MAX_DELAY_MS = 2_000;

export type ZellijTabStatusOptions = {
  execFileAsync?: ExecFileAsyncFn;
  spinnerIntervalMs?: number;
  seenPollFirstDelayMs?: number;
  now?: () => number;
};

export type TabMode = "base" | "working" | "compacting" | "done";
type Target = { ctx: ExtensionContext; mode: TabMode };
type Binding = {
  tabId: string;
  cwd: string;
  baseName: string;
  lastWrittenName: string | null;
  validatedAt: number;
};
type Update = "event" | "frame" | "poll";

export function createTabStatusController(options: ZellijTabStatusOptions = {}) {
  const exec = options.execFileAsync ?? defaultExecFileAsync;
  const now = options.now ?? Date.now;
  const spinnerIntervalMs = options.spinnerIntervalMs ?? 500;
  const firstPollDelayMs = options.seenPollFirstDelayMs ?? 250;
  let target: Target | null = null;
  let binding: Binding | null = null;
  let titleCache: { cwd: string; title: string; at: number } | null = null;
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

  async function title(cwd: string) {
    if (titleCache?.cwd === cwd && now() - titleCache.at < TITLE_CACHE_TTL_MS) return titleCache.title;
    const value = await deriveTabTitle(cwd, homedir(), exec);
    titleCache = { cwd, title: value, at: now() };
    return value;
  }

  async function ensureBinding(snapshot: Target) {
    const ctx = snapshot.ctx;
    if (binding && pathsMatch(binding.cwd, ctx.cwd) && now() - binding.validatedAt < VALIDATION_TTL_MS) return true;

    for (let attempt = 0; attempt < BIND_RETRY_ATTEMPTS && current(snapshot); attempt++) {
      const owner = await readOwningTabWith(exec, ctx);
      if (!current(snapshot)) return false;
      if (owner) {
        if (binding?.tabId === owner.tabId && pathsMatch(owner.paneCwd, binding.cwd)) {
          binding.validatedAt = now();
          return true;
        }
        const cwd = owner.paneCwd ?? ctx.cwd;
        const baseName = await title(cwd);
        if (!current(snapshot)) return false;
        binding = { tabId: owner.tabId, cwd, baseName, lastWrittenName: owner.name, validatedAt: now() };
        return true;
      }
      if (binding && pathsMatch(binding.cwd, ctx.cwd)) {
        const tab = await readTabByIdWith(exec, binding.tabId);
        if (!current(snapshot)) return false;
        if (tab) {
          binding.validatedAt = now();
          return true;
        }
      }
      binding = null;
      if (attempt < BIND_RETRY_ATTEMPTS - 1) await retryDelay();
    }
    return false;
  }

  async function rename(bound: Binding, name: string, valid: () => boolean) {
    if (bound.lastWrittenName === name) return;
    for (let attempt = 0; attempt < 2 && valid(); attempt++) {
      try {
        await runCommand(exec, "zellij", ["action", "rename-tab-by-id", bound.tabId, name]);
        // Even an obsolete write reached Zellij. Record it so the next update
        // cannot skip the corrective write based on an older cached name.
        bound.lastWrittenName = name;
        return;
      } catch {
        bound.lastWrittenName = null;
        bound.validatedAt = Number.NEGATIVE_INFINITY;
        if (attempt === 0 && valid()) await retryDelay();
      }
    }
  }

  async function render(snapshot: Target, update: Update) {
    if (update === "event") {
      if (!(await ensureBinding(snapshot)) || !current(snapshot) || !binding) return;
      const baseName = await title(binding.cwd);
      if (!current(snapshot)) return;
      binding.baseName = baseName;
    }
    if (!binding || !current(snapshot)) return;
    const bound = binding;
    let name = bound.baseName;
    if (snapshot.mode === "working") {
      name = formatWorkingTabName(bound.baseName, frame++);
    } else if (snapshot.mode === "done") {
      const tab = await readTabByIdWith(exec, bound.tabId);
      if (!current(snapshot)) return;
      if (tab?.active) {
        const baseName = await title(bound.cwd);
        if (!current(snapshot)) return;
        bound.baseName = name = baseName;
        target = { ...snapshot, mode: "base" };
        snapshot = target;
      } else {
        name = formatDoneTabName(bound.baseName);
        if (update === "poll") pollDelayMs = Math.min(pollDelayMs * 2, SEEN_POLL_MAX_DELAY_MS);
      }
    }
    await rename(bound, name, () => current(snapshot));
  }

  function scheduleNext() {
    if (closing || !binding || !target || timer !== null) return;
    const update = target.mode === "working" ? "frame" : target.mode === "done" ? "poll" : null;
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
        const freshBinding = binding && now() - binding.validatedAt < VALIDATION_TTL_MS;
        const freshTitle = titleCache && now() - titleCache.at < TITLE_CACHE_TTL_MS;
        if ((worker && !binding) || (freshBinding && freshTitle && binding?.lastWrittenName != null)) return;
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
        if (binding) await rename(binding, binding.baseName, () => true);
        binding = null;
        titleCache = null;
        target = null;
      })();
      return shutdown;
    },
  };
}
