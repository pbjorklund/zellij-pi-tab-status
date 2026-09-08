import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as status from "../pi-extension.ts";

test("formatGitTabTitle keeps the branch and truncates long paths", () => {
  assert.equal(status.formatGitTabTitle("repo/path", "feature", 40), "repo/path:feature");
  const title = status.formatGitTabTitle("very-long-repository/very-long-subdirectory", "feature/extremely-long-branch", 40);
  assert.equal([...title].length <= 40, true);
  assert.match(title, /…:feature\/extrem…$/);
});

test("deriveTabTitle uses repo path and branch without an external helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "zpts-"));
  try {
    execFileSync("git", ["init", "-q", "--initial-branch=main", root]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
    execFileSync("git", ["-C", root, "switch", "-q", "-c", "feature/tab-status"]);
    mkdirSync(join(root, "nested"));
    assert.equal(await status.deriveTabTitle(join(root, "nested")), `${basename(root)}/nested:feature/tab-status`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deriveTabTitle falls back to a directory name outside git", async () => {
  const root = mkdtempSync(join(tmpdir(), "zellij-title-dir-"));
  try {
    assert.equal(await status.deriveTabTitle(root), basename(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("titles: Unicode truncation does not split surrogate pairs", () => {
  assert.equal(status.truncateWithEllipsis("😀😀😀", 2), "😀…");
  assert.equal(status.truncateWithEllipsis("😀😀😀", 1), "…");
  assert.equal(status.truncateWithEllipsis("😀", 2), "😀");
});

test("titles: home and unresolved HEAD fallbacks", async () => {
  const failed = async () => { throw new Error("not a repo"); };
  assert.equal(await status.deriveTabTitle("/home/test/", "/home/test", failed), "~");
  const unresolved = async (_command, args) => {
    if (args[1] === "--show-toplevel") return { stdout: "/repo" };
    if (args[1] === "--show-prefix") return { stdout: "" };
    throw new Error("unresolved HEAD");
  };
  assert.equal(await status.deriveTabTitle("/repo", "/home/test", unresolved), "repo:HEAD");
});

for (const detached of [false, true]) {
  test(`titles: blank ${detached ? "detached revision" : "symbolic branch"} output keeps HEAD`, async () => {
    const exec = async (_command, args) => {
      if (args[1] === "--show-toplevel") return { stdout: "/repo\n" };
      if (args[1] === "--show-prefix") return { stdout: "\n" };
      if (detached && args[0] === "symbolic-ref") throw new Error("detached HEAD");
      return { stdout: " \n" };
    };
    assert.equal(await status.deriveTabTitle("/repo", "/home/test", exec), "repo:HEAD");
  });
}

test("titles: an unnamed directory falls back to a nonempty title", async () => {
  const failed = async () => { throw new Error("not a repo"); };
  for (const directory of ["/", ""]) {
    assert.equal(await status.deriveTabTitle(directory, "/home/test", failed), "~");
  }
});

test("titles: real Git unborn branch, detached HEAD, and linked worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "zpts-data-"));
  const repo = join(root, "repo");
  const worktree = join(root, "linked");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    mkdirSync(repo);
    git("init", "-q", "--initial-branch=main");
    assert.equal(await status.deriveTabTitle(repo), "repo:main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "init");
    const sha = git("rev-parse", "--short", "HEAD");
    git("checkout", "-q", "--detach");
    assert.equal(await status.deriveTabTitle(repo), `repo:${sha}`);
    git("worktree", "add", "-qb", "feature", worktree);
    mkdirSync(join(worktree, "nested"));
    assert.equal(await status.deriveTabTitle(join(worktree, "nested")), `${basename(worktree)}/nested:feature`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
