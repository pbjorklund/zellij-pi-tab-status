import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTabStatusController, type ZellijTabStatusOptions } from "./lib/controller.ts";
import { createWorkTracker, parseSubagentId, type SubagentLifecycleEvent } from "./lib/status-model.ts";

export type { ZellijTabStatusOptions } from "./lib/controller.ts";
export type { ZellijTabInfo } from "./lib/ownership.ts";
export { parseTabInfo, parseTabList, parsePaneInfo, parsePaneList, selectOwningPane } from "./lib/ownership.ts";
export { truncateWithEllipsis, formatGitTabTitle, deriveTabTitle } from "./lib/tab-title.ts";
export {
  stripPiTabPrefix, formatWorkingTabName, formatCompactingTabName, formatDoneTabName,
  isWorkingTabName, isCompactingTabName, parseSubagentId, createWorkTracker, isInteractiveZellij,
} from "./lib/status-model.ts";

export default function zellijPiTabStatus(pi: ExtensionAPI, options: ZellijTabStatusOptions = {}) {
  const controller = createTabStatusController(options);
  const work = createWorkTracker();
  let currentCtx: ExtensionContext | null = null;
  let compacting = false;
  let closed = false;

  function showActivity(ctx: ExtensionContext, idle: "base" | "done" = "base") {
    currentCtx = ctx;
    controller.setMode(ctx, compacting ? "compacting" : work.hasActiveWork() ? "working" : idle);
  }

  pi.on("session_start", (_event, ctx) => showActivity(ctx));
  pi.on("agent_start", (_event, ctx) => {
    work.startParentAgent();
    showActivity(ctx);
  });
  // agent_end can precede retries and queued follow-ups. Only settlement
  // ends the parent's working span.
  pi.on("agent_settled", (_event, ctx) => {
    work.endParentAgent();
    showActivity(ctx, "done");
  });
  pi.on("session_before_compact", (_event, ctx) => {
    compacting = true;
    showActivity(ctx);
  });
  for (const event of ["session_compact", "session_compact_failed"] as const) {
    pi.on(event, (_event, ctx) => {
      compacting = false;
      showActivity(ctx);
    });
  }

  pi.events?.on?.("subagents:started", (event: SubagentLifecycleEvent) => {
    if (closed || !parseSubagentId(event)) return;
    work.startSubagent(event);
    if (currentCtx) showActivity(currentCtx);
  });
  for (const event of ["subagents:completed", "subagents:failed"]) {
    pi.events?.on?.(event, (data: SubagentLifecycleEvent) => {
      if (closed || !parseSubagentId(data)) return;
      const wasWorking = work.hasActiveWork();
      work.endSubagent(data);
      if (currentCtx && wasWorking) showActivity(currentCtx, "done");
    });
  }

  pi.on("input", (event, ctx) => {
    currentCtx = ctx;
    if (event.source !== "extension" && !work.hasActiveWork()) controller.clearDone(ctx);
  });
  pi.on("session_shutdown", () => {
    closed = true;
    work.reset();
    compacting = false;
    currentCtx = null;
    return controller.close();
  });
}
