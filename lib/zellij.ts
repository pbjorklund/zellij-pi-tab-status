import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCommand, type ExecFileAsyncFn } from "./commands.ts";
import { parsePaneList, parseTabList, selectOwningPane, type ZellijTabInfo } from "./ownership.ts";
import type { TabBinding } from "./tab-binding.ts";

export type OwningTabInfo = ZellijTabInfo & { paneCwd: string | null };

export async function readOwningTabWith(
  exec: ExecFileAsyncFn,
  ctx: Pick<ExtensionContext, "cwd">,
): Promise<OwningTabInfo | null> {
  try {
    const [{ stdout: panesStdout }, tabsResult] = await Promise.all([
      runCommand(exec, "zellij", ["action", "list-panes", "--all", "--json", "--command", "--state"]),
      runCommand(exec, "zellij", ["action", "list-tabs", "--json", "--state"]).catch(() => ({ stdout: "[]" })),
    ]);
    const pane = selectOwningPane(
      parsePaneList(panesStdout),
      parseTabList(tabsResult.stdout),
      ctx.cwd,
      process.env.ZELLIJ_PANE_ID,
    );
    if (!pane) return null;
    return { tabId: pane.tabId, name: pane.tabName, active: false, paneCwd: pane.paneCwd };
  } catch {
    return null;
  }
}

export async function readTabByIdWith(exec: ExecFileAsyncFn, tabId: string): Promise<ZellijTabInfo | null> {
  try {
    const { stdout } = await runCommand(exec, "zellij", ["action", "list-tabs", "--json", "--state"]);
    return parseTabList(stdout).find((tab) => tab.tabId === tabId) ?? null;
  } catch {
    return null;
  }
}

export function createTabWriter(exec: ExecFileAsyncFn, retryDelay: () => Promise<void>) {
  async function rename(bound: TabBinding, name: string, valid: () => boolean) {
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

  return {
    rename,
    async release(bound: TabBinding, valid: () => boolean) {
      if (bound.lastWrittenName === null || bound.lastWrittenName === bound.baseName) return;
      const tab = await readTabByIdWith(exec, bound.tabId);
      // A moved pane no longer owns this tab. Remove only our unchanged overlay.
      if (valid() && tab?.name === bound.lastWrittenName) await rename(bound, bound.baseName, valid);
    },
  };
}
