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
