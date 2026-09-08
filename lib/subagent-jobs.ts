import type { ExtensionContext, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { isInteractiveZellij } from "./status-model.ts";

const COMPLETION_TYPE = "pi-subagents-completion";
const TERMINAL_STATES = new Set(["completed", "partial", "failed", "timed_out", "cancelled"]);
const JOB_TOOLS = new Set(["subagent_spawn", "subagent_wait", "subagent_cancel", "subagent_inspect"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function createSubagentJobObserver(
  onChange: (id: string, active: boolean, ctx: ExtensionContext) => void,
) {
  const active = new Set<string>();
  // A fast child can complete before its spawn result reaches our handler.
  const finished = new Set<string>();
  let ctx: ExtensionContext | null = null;
  let cursor: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function stopTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function observe(value: unknown) {
    const job = record(value);
    if (!ctx || typeof job?.jobId !== "string" || !job.jobId.trim()) return;
    const id = job.jobId;
    if (typeof job.state === "string" && TERMINAL_STATES.has(job.state)) {
      finished.add(id);
      if (active.delete(id)) onChange(id, false, ctx);
    } else if ((job.state === "queued" || job.state === "running") && !finished.has(id) && !active.has(id)) {
      active.add(id);
      onChange(id, true, ctx);
    }
  }

  function readCompletions() {
    const session = ctx?.sessionManager;
    if (!session) return;
    const leaf = session.getLeafId();
    let id = leaf;
    while (id && id !== cursor) {
      const entry = session.getEntry(id);
      if (!entry) break;
      if (entry.type === "custom_message" && entry.customType === COMPLETION_TYPE) {
        const job = record(entry.details);
        if (typeof job?.state === "string" && TERMINAL_STATES.has(job.state)) observe(job);
      }
      id = entry.parentId;
    }
    cursor = leaf;
  }

  function schedule() {
    if (active.size === 0) stopTimer();
    if (closed || active.size === 0 || timer !== null) return;
    // Idle custom messages reach session history but not extension message hooks.
    // Read only the new in-memory tail, and only while jobs remain active.
    timer = setTimeout(() => {
      timer = null;
      readCompletions();
      schedule();
    }, 500);
    timer.unref?.();
  }

  return {
    start(context: ExtensionContext) {
      ctx = context;
      cursor = context.sessionManager?.getLeafId() ?? null;
    },
    toolEnd(event: ToolExecutionEndEvent, context: ExtensionContext) {
      if (closed || !isInteractiveZellij(context) || event.isError || !JOB_TOOLS.has(event.toolName)) return;
      ctx = context;
      const details = record(record(event.result)?.details);
      if (event.toolName === "subagent_inspect") {
        if (Array.isArray(details?.jobs)) for (const job of details.jobs) observe(job);
      } else {
        observe(details);
      }
      readCompletions();
      schedule();
    },
    close() {
      closed = true;
      stopTimer();
      active.clear();
      finished.clear();
      ctx = null;
      cursor = null;
    },
  };
}
