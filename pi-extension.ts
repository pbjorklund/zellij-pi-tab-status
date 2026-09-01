import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 2_000;
const SEEN_POLL_INTERVAL_MS = 1_000;
const BIND_RETRY_ATTEMPTS = 20;
const BIND_RETRY_DELAY_MS = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const COMPACTION_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const DONE_PREFIX = "●";
const MAX_TITLE_LENGTH = 40;

export type ZellijTabInfo = {
  tabId: string;
  name: string;
  active: boolean;
};

type RuntimeState = {
  tabId: string;
  baseName: string;
  baseCwd: string | null;
  lastWrittenName: string | null;
  doneUnseen: boolean;
};

type OwningTabInfo = ZellijTabInfo & {
  paneCwd: string | null;
};

type JsonRecord = Record<string, unknown>;

type ZellijPaneInfo = {
  paneId: string;
  tabId: string;
  tabName: string;
  tabPosition: number | null;
  paneCommand: string | null;
  terminalCommand: string | null;
  paneCwd: string | null;
  title: string | null;
  focused: boolean;
  plugin: boolean;
};

type SubagentLifecycleEvent = {
  id?: unknown;
};

type CompactionLifecycleEvent = {
  willRetry?: unknown;
};

export function stripPiTabPrefix(name: string): string {
  const trimmed = name.trimStart();

  for (const frame of [...SPINNER_FRAMES, ...COMPACTION_FRAMES]) {
    const prefix = `${frame} `;
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }

  const donePrefix = `${DONE_PREFIX} `;
  if (trimmed.startsWith(donePrefix)) return trimmed.slice(donePrefix.length);

  return name;
}

export function formatWorkingTabName(baseName: string, _frameIndex: number): string {
  return `${SPINNER_FRAMES[0]} ${baseName}`;
}

export function formatCompactingTabName(baseName: string, frameIndex: number): string {
  return `${COMPACTION_FRAMES[frameIndex % COMPACTION_FRAMES.length]} ${baseName}`;
}

export function formatDoneTabName(baseName: string): string {
  return `${DONE_PREFIX} ${baseName}`;
}

export function isWorkingTabName(name: string): boolean {
  const trimmed = name.trimStart();
  return SPINNER_FRAMES.some((frame) => trimmed.startsWith(`${frame} `));
}

export function isCompactingTabName(name: string): boolean {
  const trimmed = name.trimStart();
  return COMPACTION_FRAMES.some((frame) => trimmed.startsWith(`${frame} `));
}

function isAnimatedTabName(name: string): boolean {
  return isWorkingTabName(name) || isCompactingTabName(name);
}

export function parseTabInfo(value: unknown): ZellijTabInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as JsonRecord;
  const tabId = record.tab_id;
  const name = record.name;

  if ((typeof tabId !== "string" && typeof tabId !== "number") || typeof name !== "string") {
    return null;
  }

  return {
    tabId: String(tabId),
    name,
    active: record.active === true,
  };
}

export function parseTabList(stdout: string): ZellijTabInfo[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(parseTabInfo).filter((tab): tab is ZellijTabInfo => tab !== null);
}

export function parsePaneInfo(value: unknown): ZellijPaneInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as JsonRecord;
  const paneId = record.id;
  const tabId = record.tab_id;
  const tabName = record.tab_name;

  if (
    (typeof paneId !== "string" && typeof paneId !== "number") ||
    (typeof tabId !== "string" && typeof tabId !== "number") ||
    typeof tabName !== "string"
  ) {
    return null;
  }

  return {
    paneId: String(paneId),
    tabId: String(tabId),
    tabName,
    tabPosition: typeof record.tab_position === "number" ? record.tab_position : null,
    paneCommand: typeof record.pane_command === "string" ? record.pane_command : null,
    terminalCommand: typeof record.terminal_command === "string" ? record.terminal_command : null,
    paneCwd: typeof record.pane_cwd === "string" ? record.pane_cwd : null,
    title: typeof record.title === "string" ? record.title : null,
    focused: record.is_focused === true,
    plugin: record.is_plugin === true,
  };
}

export function parsePaneList(stdout: string): ZellijPaneInfo[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map(parsePaneInfo).filter((pane): pane is ZellijPaneInfo => pane !== null);
}

export function parseSubagentId(event: SubagentLifecycleEvent): string | null {
  return typeof event.id === "string" && event.id.trim().length > 0 ? event.id : null;
}

export function parseCompactionWillRetry(event: CompactionLifecycleEvent): boolean | null {
  return typeof event.willRetry === "boolean" ? event.willRetry : null;
}

export function createWorkTracker() {
  let parentAgentActive = false;
  const activeSubagentIds = new Set<string>();

  return {
    startParentAgent() {
      parentAgentActive = true;
    },
    endParentAgent() {
      parentAgentActive = false;
    },
    startSubagent(event: SubagentLifecycleEvent) {
      const id = parseSubagentId(event);
      if (id) activeSubagentIds.add(id);
    },
    endSubagent(event: SubagentLifecycleEvent) {
      const id = parseSubagentId(event);
      if (id) activeSubagentIds.delete(id);
    },
    reset() {
      parentAgentActive = false;
      activeSubagentIds.clear();
    },
    hasActiveWork() {
      return parentAgentActive || activeSubagentIds.size > 0;
    },
    activeSubagentCount() {
      return activeSubagentIds.size;
    },
  };
}

export function isInteractiveZellij(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
  return ctx.mode === "tui" && ctx.hasUI && Boolean(process.env.ZELLIJ);
}

async function run(command: string, args: string[], options: { cwd?: string } = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncateWithEllipsis(value: string, maxLength: number): string {
  const characters = [...value];
  if (characters.length <= maxLength) return value;
  if (maxLength <= 1) return "…";
  return `${characters.slice(0, maxLength - 1).join("")}…`;
}

export function formatGitTabTitle(path: string, branch: string, maxLength = MAX_TITLE_LENGTH): string {
  const title = `${path}:${branch}`;
  if ([...title].length <= maxLength) return title;

  const shortBranch = truncateWithEllipsis(branch, 15);
  const pathLength = Math.max(1, maxLength - [...shortBranch].length - 1);
  return `${truncateWithEllipsis(path, pathLength)}:${shortBranch}`;
}

export async function deriveTabTitle(directory: string, home = homedir()): Promise<string> {
  try {
    const [{ stdout: rootStdout }, { stdout: prefixStdout }] = await Promise.all([
      run("git", ["rev-parse", "--show-toplevel"], { cwd: directory }),
      run("git", ["rev-parse", "--show-prefix"], { cwd: directory }),
    ]);
    const root = rootStdout.trim();
    const prefix = prefixStdout.trim().replace(/\/$/, "");
    const path = prefix ? `${basename(root)}/${prefix}` : basename(root);

    let branch = "HEAD";
    try {
      const { stdout } = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: directory });
      branch = stdout.trim() || branch;
    } catch {
      try {
        const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: directory });
        branch = stdout.trim() || branch;
      } catch {
        // Keep HEAD for an unborn or otherwise unresolved repository.
      }
    }

    return formatGitTabTitle(path, branch);
  } catch {
    const normalizedDirectory = normalizePath(directory);
    const normalizedHome = normalizePath(home);
    const title = normalizedDirectory === normalizedHome ? "~" : basename(normalizedDirectory ?? directory);
    return truncateWithEllipsis(title || "~", MAX_TITLE_LENGTH);
  }
}

function normalizePath(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\/+$/, "") || "/";
}

function pathsMatch(left: string | null, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function looksLikePiPane(pane: ZellijPaneInfo): boolean {
  const paneCommand = pane.paneCommand ?? "";
  const terminalCommand = pane.terminalCommand ?? "";
  const title = pane.title ?? "";

  return (
    paneCommand === "pi" ||
    paneCommand.startsWith("pi ") ||
    /(^|\s|[;&|])pi(\s|$)/.test(terminalCommand) ||
    title === "pi" ||
    title.startsWith("π")
  );
}

export function selectOwningPane(
  panes: ZellijPaneInfo[],
  tabs: ZellijTabInfo[],
  cwd: string,
  envPaneId: string | undefined,
): ZellijPaneInfo | null {
  const terminalPanes = panes.filter((pane) => !pane.plugin);
  if (terminalPanes.length === 0) return null;

  const activeTabIds = new Set(tabs.filter((tab) => tab.active).map((tab) => tab.tabId));
  const cwdMatches = terminalPanes.filter((pane) => pathsMatch(pane.paneCwd, cwd));
  const envPane = envPaneId ? terminalPanes.find((pane) => pane.paneId === envPaneId) : undefined;

  // The pane id exported to the PI process is the strongest owner signal, but
  // only trust it when Zellij also reports this process cwd. Zellij pane ids can
  // collide with plugin ids, and old shells can leave stale ZELLIJ_PANE_ID values.
  if (envPane && pathsMatch(envPane.paneCwd, cwd)) return envPane;

  if (cwdMatches.length === 0) return null;

  return cwdMatches
    .map((pane) => {
      const score =
        (pathsMatch(pane.paneCwd, cwd) ? 100 : 0) +
        (looksLikePiPane(pane) ? 40 : 0) +
        (activeTabIds.has(pane.tabId) ? 50 : 0) +
        (pane.focused ? 10 : 0) +
        (envPaneId && pane.paneId === envPaneId ? 30 : 0) +
        (pane.tabPosition ?? 0) / 1000;

      return { pane, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.pane ?? null;
}

async function readOwningTab(ctx: ExtensionContext): Promise<OwningTabInfo | null> {
  try {
    const [{ stdout: panesStdout }, tabsResult] = await Promise.all([
      run("zellij", ["action", "list-panes", "--all", "--json", "--command", "--state"]),
      run("zellij", ["action", "list-tabs", "--json", "--state"]).catch(() => ({ stdout: "[]" })),
    ]);

    const pane = selectOwningPane(
      parsePaneList(panesStdout),
      parseTabList(tabsResult.stdout),
      ctx.cwd,
      process.env.ZELLIJ_PANE_ID,
    );
    if (!pane) return null;

    return {
      tabId: pane.tabId,
      name: pane.tabName,
      active: false,
      paneCwd: pane.paneCwd,
    };
  } catch {
    return null;
  }
}

async function readTabById(tabId: string): Promise<ZellijTabInfo | null> {
  try {
    const { stdout } = await run("zellij", ["action", "list-tabs", "--json", "--state"]);
    return parseTabList(stdout).find((tab) => tab.tabId === tabId) ?? null;
  } catch {
    return null;
  }
}

export default function zellijPiTabStatus(pi: ExtensionAPI) {
  let state: RuntimeState | null = null;
  let seenTimer: ReturnType<typeof setInterval> | null = null;
  const workTracker = createWorkTracker();
  let currentCtx: ExtensionContext | null = null;
  let frameIndex = 0;
  let compactionActive = false;
  let compactionWillRetry: boolean | null = null;
  let pendingName: string | null = null;
  let renameDrain: Promise<void> | null = null;

  async function resolveBaseName(cwd: string | null, fallbackName: string): Promise<string> {
    if (!cwd) return stripPiTabPrefix(fallbackName);

    const title = await deriveTabTitle(cwd);
    return title.length > 0 ? title : stripPiTabPrefix(fallbackName);
  }

  async function bindOwningTab(ctx: ExtensionContext): Promise<boolean> {
    const tab = await readOwningTab(ctx);
    if (!tab) return false;

    const baseCwd = tab.paneCwd ?? ctx.cwd;
    const baseName = await resolveBaseName(baseCwd, tab.name);
    state = {
      tabId: tab.tabId,
      baseName,
      baseCwd,
      lastWrittenName: tab.name,
      doneUnseen: false,
    };

    if (tab.name !== baseName) await renameTab(baseName);
    return true;
  }

  async function ensureOwningTab(ctx: ExtensionContext, attempts = 1): Promise<boolean> {
    if (!isInteractiveZellij(ctx)) return false;

    if (state) {
      const owningTab = await readOwningTab(ctx);
      if (owningTab) {
        const sameTab = owningTab.tabId === state.tabId;
        const sameCwd = pathsMatch(owningTab.paneCwd, state.baseCwd ?? ctx.cwd);
        if (sameTab && sameCwd && (await readTabById(state.tabId))) return true;

        // PI panes can be moved between tabs after startup. Rebind instead of
        // keeping a stale tab id that would animate an unrelated tab.
        state = null;
      } else if (await readTabById(state.tabId)) {
        return true;
      }
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await bindOwningTab(ctx)) return true;
      if (attempt < attempts - 1) await sleep(BIND_RETRY_DELAY_MS);
    }

    return false;
  }

  async function drainRenameQueue() {
    while (pendingName && state) {
      const nextName = pendingName;
      pendingName = null;
      try {
        await run("zellij", ["action", "rename-tab-by-id", state.tabId, nextName]);
        state.lastWrittenName = nextName;
      } catch {
        // Best effort only. Tab naming must never interrupt PI work.
      }
    }
  }

  function ensureRenameDrain() {
    renameDrain ??= drainRenameQueue().finally(() => {
      renameDrain = null;
    });
    return renameDrain;
  }

  async function renameTab(name: string) {
    if (!state || state.lastWrittenName === name) return;
    if (isAnimatedTabName(name) && !workTracker.hasActiveWork() && !compactionActive) return;

    pendingName = name;
    await ensureRenameDrain();

    if (pendingName) {
      await ensureRenameDrain();
    }
  }

  async function refreshBaseName(ctx: ExtensionContext) {
    if (!state) return;

    const tab = await readTabById(state.tabId);
    if (tab) {
      state.baseName = await resolveBaseName(state.baseCwd ?? ctx.cwd, tab.name);
    }
  }

  function stopSpinner() {
    frameIndex = 0;
  }

  function stopSeenPolling() {
    if (!seenTimer) return;
    clearInterval(seenTimer);
    seenTimer = null;
  }

  async function restoreBase(ctx: ExtensionContext) {
    stopSpinner();
    stopSeenPolling();
    if (!state) return;
    state.doneUnseen = false;
    await refreshBaseName(ctx);
    await renameTab(state.baseName);
  }

  async function showWorking(ctx: ExtensionContext) {
    if (compactionActive) return;
    if (!(await ensureOwningTab(ctx, BIND_RETRY_ATTEMPTS)) || !state) return;

    stopSeenPolling();
    await refreshBaseName(ctx);
    state.doneUnseen = false;

    await renameTab(formatWorkingTabName(state.baseName, frameIndex++));
  }

  async function showCompacting(ctx: ExtensionContext, willRetry: boolean | null) {
    compactionActive = true;
    compactionWillRetry = willRetry;
    if (!(await ensureOwningTab(ctx, BIND_RETRY_ATTEMPTS)) || !state) return;

    stopSeenPolling();
    stopSpinner();
    await refreshBaseName(ctx);
    state.doneUnseen = false;

    // Compaction can finish after the agent turn is already over. Do not run a
    // second tab-name ticker here; clear any active work ticker and keep the
    // base tab name until compaction resolves.
    await renameTab(state.baseName);
  }

  async function finishCompacting(ctx: ExtensionContext, willRetry: boolean | null) {
    compactionActive = false;
    compactionWillRetry = null;
    stopSpinner();

    if (willRetry === false) {
      workTracker.endParentAgent();
    }

    if (workTracker.hasActiveWork()) {
      await showWorking(ctx);
      return;
    }

    await finishIfIdle(ctx);
  }

  async function finishIfIdle(ctx: ExtensionContext) {
    if (compactionActive) return;
    if (!(await ensureOwningTab(ctx)) || !state) return;

    if (workTracker.hasActiveWork()) return;

    stopSpinner();
    await refreshBaseName(ctx);

    const tab = await readTabById(state.tabId);
    if (tab?.active) {
      await restoreBase(ctx);
      return;
    }

    state.doneUnseen = true;
    await renameTab(formatDoneTabName(state.baseName));
    startSeenPolling(ctx);
  }

  function startSeenPolling(ctx: ExtensionContext) {
    stopSeenPolling();
    seenTimer = setInterval(() => {
      void (async () => {
        if (!state?.doneUnseen) return;
        const tab = await readTabById(state.tabId);
        if (tab?.active) await restoreBase(ctx);
      })();
    }, SEEN_POLL_INTERVAL_MS);
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    void ensureOwningTab(ctx, BIND_RETRY_ATTEMPTS);
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentCtx = ctx;
    workTracker.startParentAgent();
    await showWorking(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    currentCtx = ctx;
    workTracker.endParentAgent();
    await finishIfIdle(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    currentCtx = ctx;
    await showCompacting(ctx, parseCompactionWillRetry(event));
  });

  pi.on("session_compact", async (event, ctx) => {
    currentCtx = ctx;
    await finishCompacting(ctx, parseCompactionWillRetry(event) ?? compactionWillRetry);
  });

  pi.events?.on?.("subagents:started", (event: SubagentLifecycleEvent) => {
    workTracker.startSubagent(event);
    return currentCtx ? showWorking(currentCtx) : undefined;
  });

  pi.events?.on?.("subagents:completed", (event: SubagentLifecycleEvent) => {
    workTracker.endSubagent(event);
    return currentCtx ? finishIfIdle(currentCtx) : undefined;
  });

  pi.events?.on?.("subagents:failed", (event: SubagentLifecycleEvent) => {
    workTracker.endSubagent(event);
    return currentCtx ? finishIfIdle(currentCtx) : undefined;
  });

  pi.on("input", async (event, ctx) => {
    currentCtx = ctx;
    if (event.source === "extension" || !state?.doneUnseen || workTracker.hasActiveWork()) return;
    await restoreBase(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await restoreBase(ctx);
    workTracker.reset();
    compactionActive = false;
    compactionWillRetry = null;
    state = null;
    currentCtx = null;
    pendingName = null;
    renameDrain = null;
  });
}
