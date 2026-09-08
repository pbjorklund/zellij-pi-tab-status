import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const defaultExecFileAsync = promisify(execFile);
export type ExecFileAsyncFn = typeof defaultExecFileAsync;
const COMMAND_TIMEOUT_MS = 2_000;

export async function runCommand(
  execFileAsync: ExecFileAsyncFn,
  command: string,
  args: string[],
  options: { cwd?: string } = {},
) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}
