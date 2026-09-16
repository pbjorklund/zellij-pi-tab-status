import type { ExtensionContext, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { isInteractiveZellij } from "./status-model.ts";

const COMPLETION_TYPE = "subagent_result";
const ACTIVE_STATES = new Set(["started", "running", "stopping"]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const JOB_TOOLS = new Set(["subagent", "subagent_resume", "subagent_kill"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

type JobUpdate = { id: string; active: boolean };

export function parseJobUpdate(value: unknown): JobUpdate | null {
  const job = record(value);
  const id = typeof job?.id === "string" ? job.id : job?.jobId;
  if (typeof id !== "string" || !id.trim()) return null;
  const state = typeof job.status === "string" ? job.status : job.state;
  if (typeof state === "string" && ACTIVE_STATES.has(state)) return { id, active: true };
  if (typeof state === "string" && TERMINAL_STATES.has(state)) return { id, active: false };
  return null;
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

  function observe(job: JobUpdate | null) {
    if (!ctx || !job) return;
    const { id } = job;
    if (!job.active) {
      finished.add(id);
      if (active.delete(id)) onChange(id, false, ctx);
    } else if (!finished.has(id) && !active.has(id)) {
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
        const job = parseJobUpdate(entry.details);
        if (job?.active === false) observe(job);
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
      const details = record(event.result)?.details;
      observe(parseJobUpdate(details));
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
