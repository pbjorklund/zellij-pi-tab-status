export type ZellijTabInfo = {
  tabId: string;
  name: string;
  active: boolean;
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

export function normalizePath(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\/+$/, "") || "/";
}

export function pathsMatch(left: string | null, right: string): boolean {
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

  let selected: ZellijPaneInfo | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const pane of cwdMatches) {
    const score =
      (looksLikePiPane(pane) ? 40 : 0) +
      (activeTabIds.has(pane.tabId) ? 50 : 0) +
      (pane.focused ? 10 : 0) +
      (pane.tabPosition ?? 0) / 1000;
    if (score > bestScore) {
      selected = pane;
      bestScore = score;
    }
  }
  return selected;
}
