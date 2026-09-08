import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import type { ExecFileAsyncFn } from "./commands.ts";
import { pathsMatch, readOwningTabWith, readTabByIdWith } from "./ownership.ts";
import { deriveTabTitle } from "./tab-title.ts";

const VALIDATION_TTL_MS = 5_000;
const TITLE_CACHE_TTL_MS = 30_000;
const BIND_RETRY_ATTEMPTS = 20;

export type TabBinding = {
  tabId: string;
  cwd: string;
  baseName: string;
  lastWrittenName: string | null;
  validatedAt: number;
};

export function createTabBinding(
  exec: ExecFileAsyncFn,
  now: () => number,
  retryDelay: () => Promise<void>,
) {
  let binding: TabBinding | null = null;
  let titleCache: { cwd: string; title: string; at: number } | null = null;

  async function title(cwd: string) {
    if (titleCache?.cwd === cwd && now() - titleCache.at < TITLE_CACHE_TTL_MS) return titleCache.title;
    const value = await deriveTabTitle(cwd, homedir(), exec);
    titleCache = { cwd, title: value, at: now() };
    return value;
  }

  async function ensure(ctx: ExtensionContext, valid: () => boolean) {
    if (binding && pathsMatch(binding.cwd, ctx.cwd) && now() - binding.validatedAt < VALIDATION_TTL_MS) return binding;

    for (let attempt = 0; attempt < BIND_RETRY_ATTEMPTS && valid(); attempt++) {
      const owner = await readOwningTabWith(exec, ctx);
      if (!valid()) return null;
      if (owner) {
        if (binding?.tabId === owner.tabId && pathsMatch(owner.paneCwd, binding.cwd)) {
          binding.validatedAt = now();
          return binding;
        }
        const cwd = owner.paneCwd ?? ctx.cwd;
        const baseName = await title(cwd);
        if (!valid()) return null;
        binding = { tabId: owner.tabId, cwd, baseName, lastWrittenName: owner.name, validatedAt: now() };
        return binding;
      }
      if (binding && pathsMatch(binding.cwd, ctx.cwd)) {
        const tab = await readTabByIdWith(exec, binding.tabId);
        if (!valid()) return null;
        if (tab) {
          binding.validatedAt = now();
          return binding;
        }
      }
      binding = null;
      if (attempt < BIND_RETRY_ATTEMPTS - 1) await retryDelay();
    }
    return null;
  }

  return {
    current: () => binding,
    ensure,
    title,
    isFresh() {
      return binding !== null && binding.lastWrittenName !== null
        && now() - binding.validatedAt < VALIDATION_TTL_MS
        && titleCache !== null && now() - titleCache.at < TITLE_CACHE_TTL_MS;
    },
    clear() {
      binding = null;
      titleCache = null;
    },
  };
}
