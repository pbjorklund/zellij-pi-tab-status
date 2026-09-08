import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const COMPACTION_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const DONE_PREFIX = "●";

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

export function formatWorkingTabName(baseName: string, frameIndex: number): string {
  return `${SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]} ${baseName}`;
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

export function isInteractiveZellij(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
  return ctx.mode === "tui" && ctx.hasUI && Boolean(process.env.ZELLIJ);
}
