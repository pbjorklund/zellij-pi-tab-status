export type TabMode = "base" | "working" | "compacting" | "done";
export type SubagentLifecycleEvent = { id?: unknown };

export function parseSubagentId(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const { id } = event as SubagentLifecycleEvent;
  return typeof id === "string" && id.trim().length > 0 ? id : null;
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

export function createActivityState() {
  const work = createWorkTracker();
  let compaction: "inactive" | "active" | "work-completed" = "inactive";

  function mode(idle: "base" | "done" = "base"): TabMode {
    if (compaction !== "inactive") return "compacting";
    return work.hasActiveWork() ? "working" : idle;
  }

  function completeWork() {
    if (compaction !== "inactive" && !work.hasActiveWork()) compaction = "work-completed";
    return mode("done");
  }

  return {
    // The controller owns seen/unseen completion. Emit done on transitions,
    // rather than storing a second copy that could outlive the controller's marker.
    mode: () => mode(),
    hasActiveWork: work.hasActiveWork,
    startParent() {
      work.startParentAgent();
      return mode();
    },
    settleParent() {
      work.endParentAgent();
      return completeWork();
    },
    startChild(id: string) {
      work.startSubagent({ id });
      return mode();
    },
    finishChild(id: string) {
      work.endSubagent({ id });
      return completeWork();
    },
    startCompaction(): TabMode {
      compaction = "active";
      return "compacting";
    },
    finishCompaction() {
      const idle = compaction === "work-completed" ? "done" : "base";
      compaction = "inactive";
      return mode(idle);
    },
    reset() {
      work.reset();
      compaction = "inactive";
    },
  };
}
