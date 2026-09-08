import { homedir } from "node:os";
import { basename } from "node:path";
import { defaultExecFileAsync, runCommand, type ExecFileAsyncFn } from "./commands.ts";
import { normalizePath } from "./ownership.ts";

const MAX_TITLE_LENGTH = 40;

export function truncateWithEllipsis(value: string, maxLength: number): string {
  const characters = [...value];
  if (characters.length <= maxLength) return value;
  if (maxLength <= 1) return "…";
  return `${characters.slice(0, maxLength - 1).join("")}…`;
}

export function formatGitTabTitle(path: string, branch: string, maxLength = MAX_TITLE_LENGTH): string {
  const title = `${path}:${branch}`;
  if ([...title].length <= maxLength) return title;

  const shortBranch = truncateWithEllipsis(branch, 15);
  const pathLength = Math.max(1, maxLength - [...shortBranch].length - 1);
  return `${truncateWithEllipsis(path, pathLength)}:${shortBranch}`;
}

export async function deriveTabTitle(
  directory: string,
  home = homedir(),
  execFileAsync: ExecFileAsyncFn = defaultExecFileAsync,
): Promise<string> {
  try {
    const [{ stdout: rootStdout }, { stdout: prefixStdout }] = await Promise.all([
      runCommand(execFileAsync, "git", ["rev-parse", "--show-toplevel"], { cwd: directory }),
      runCommand(execFileAsync, "git", ["rev-parse", "--show-prefix"], { cwd: directory }),
    ]);
    const root = rootStdout.trim();
    const prefix = prefixStdout.trim().replace(/\/$/, "");
    const path = prefix ? `${basename(root)}/${prefix}` : basename(root);

    let branch = "HEAD";
    try {
      const { stdout } = await runCommand(execFileAsync, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: directory });
      branch = stdout.trim() || branch;
    } catch {
      try {
        const { stdout } = await runCommand(execFileAsync, "git", ["rev-parse", "--short", "HEAD"], { cwd: directory });
        branch = stdout.trim() || branch;
      } catch {
        // Keep HEAD for an unborn or otherwise unresolved repository.
      }
    }

    return formatGitTabTitle(path, branch);
  } catch {
    const normalizedDirectory = normalizePath(directory);
    const normalizedHome = normalizePath(home);
    const title = normalizedDirectory === normalizedHome ? "~" : basename(normalizedDirectory ?? directory);
    return truncateWithEllipsis(title || "~", MAX_TITLE_LENGTH);
  }
}
