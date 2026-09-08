import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTabStatusController, type ZellijTabStatusOptions } from "./lib/controller.ts";
import { createActivityState, parseSubagentId, type TabMode } from "./lib/activity.ts";
import { createSubagentJobObserver } from "./lib/subagent-jobs.ts";

export type { ZellijTabStatusOptions } from "./lib/controller.ts";
export type { ZellijTabInfo } from "./lib/ownership.ts";
export { parseTabInfo, parseTabList, parsePaneInfo, parsePaneList, selectOwningPane } from "./lib/ownership.ts";
export { truncateWithEllipsis, formatGitTabTitle, deriveTabTitle } from "./lib/tab-title.ts";
export {
  stripPiTabPrefix, formatWorkingTabName, formatCompactingTabName, formatDoneTabName,
  isWorkingTabName, isCompactingTabName, isInteractiveZellij,
} from "./lib/status-model.ts";
export { parseSubagentId, createWorkTracker } from "./lib/activity.ts";

export default function zellijPiTabStatus(pi: ExtensionAPI, options: ZellijTabStatusOptions = {}) {
  const controller = createTabStatusController(options);
  const activity = createActivityState();
  let currentCtx: ExtensionContext | null = null;
  let closed = false;

  function showActivity(ctx: ExtensionContext, mode: TabMode) {
    currentCtx = ctx;
    controller.setMode(ctx, mode);
  }

  const jobs = createSubagentJobObserver((id, active, ctx) => {
    showActivity(ctx, active ? activity.startChild(id) : activity.finishChild(id));
  });

  pi.on("session_start", (_event, ctx) => {
    jobs.start(ctx);
    showActivity(ctx, activity.mode());
  });
  pi.on("tool_execution_end", (event, ctx) => jobs.toolEnd(event, ctx));
  pi.on("agent_start", (_event, ctx) => showActivity(ctx, activity.startParent()));
  // agent_end can precede retries and queued follow-ups. Only settlement
  // ends the parent's working span.
  pi.on("agent_settled", (_event, ctx) => showActivity(ctx, activity.settleParent()));
  pi.on("session_before_compact", (_event, ctx) => showActivity(ctx, activity.startCompaction()));
  const finishCompacting = (_event: unknown, ctx: ExtensionContext) => showActivity(ctx, activity.finishCompaction());
  pi.on("session_compact", finishCompacting);
  pi.on("session_compact_failed", finishCompacting);

  pi.events?.on?.("subagents:started", (event) => {
    const id = parseSubagentId(event);
    if (closed || !id) return;
    const mode = activity.startChild(id);
    if (currentCtx) showActivity(currentCtx, mode);
  });
  for (const event of ["subagents:completed", "subagents:failed"]) {
    pi.events?.on?.(event, (data) => {
      const id = parseSubagentId(data);
      if (closed || !id || !activity.hasActiveWork()) return;
      const mode = activity.finishChild(id);
      if (currentCtx) showActivity(currentCtx, mode);
    });
  }

  pi.on("input", (event, ctx) => {
    currentCtx = ctx;
    if (event.source !== "extension" && !activity.hasActiveWork()) controller.clearDone(ctx);
  });
  pi.on("session_shutdown", () => {
    closed = true;
    jobs.close();
    activity.reset();
    currentCtx = null;
    return controller.close();
  });
}
