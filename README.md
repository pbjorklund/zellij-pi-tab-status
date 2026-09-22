# zellij-pi-tab-status

A PI extension that publishes agent state to the `zellij-tabbar` vertical sidebar.

While PI works, the sidebar shows an animated spinner beside the owning tab. When a background run settles, it shows `●` until you view that tab. Spinner frames are rendered inside the sidebar; they do not rename the tab every 500 ms.

Use it when PI runs inside Zellij with the matching custom vertical sidebar and background completion should stay visible across tabs. Do not use it outside a supported PI TUI, as a job audit log, or with Zellij's built-in tab bar when status markers are required.

## Install

Install the matching [zellij-tabbar](https://github.com/pbjorklund/zellij-tabbar) WASM and layout first. Then add this Git package to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/pbjorklund/zellij-pi-tab-status"
  ]
}
```

Run `pi update` or restart PI and approve package installation when prompted. No config file is required. `PI_SUBAGENT_ZELLIJ_PLACEMENT` belongs to `pi-subagents`, not this status extension.

Update with `pi update git:github.com/pbjorklund/zellij-pi-tab-status`, then reload PI. Remove the package with `pi remove git:github.com/pbjorklund/zellij-pi-tab-status`; remove the matching sidebar separately if nothing else uses it.

## Behavior

- Runs only in PI's TUI inside Zellij.
- Sends a complete `pi_status` snapshot when state changes, then replays the same active snapshot every five seconds so newly loaded sidebars catch up. It sends no animation frames.
- Uses the stable Zellij pane ID, a runtime ID, and a monotonic sequence so moved panes and stale updates remain distinguishable.
- Keeps the parent and tracked subagent state working until all work settles.
- Keeps work marked across automatic retries, queued follow-ups, and compaction recovery.
- Publishes `compacting` during manual and automatic compaction, then restores the effective state after success, failure, or cancellation.
- Publishes `done` once the parent has settled and all tracked subagents have finished. The visible sidebar clears it immediately; the extension confirms tab visibility with bounded backoff and publishes `base` so every sidebar instance converges.
- Publishes a runtime-specific removal during shutdown.
- Maintains a static `repository/path:branch` tab title for Git worktrees, or the directory name elsewhere. It changes the title only when the base title changes.
- Coalesces event bursts and treats Zellij commands as best effort, so status failures do not block PI lifecycle hooks.

Subagent tracking supports both the `subagents:started` / `subagents:completed` / `subagents:failed` event bus (payload: `{ id }`) and the `@narumitw/pi-subagents` named-agent tools (`subagent`, `subagent_resume`, and `subagent_kill`). It reads new `subagent_result` entries from in-memory session history every 500 ms while agents are active. This catches asynchronous completions while the parent is idle without reading session files or spawning status-frame processes.

The extension needs PI 0.87.0 or newer and a Zellij version that provides `list-panes`, `list-tabs`, `rename-tab-by-id`, and `pipe`. Status markers require the matching custom sidebar; Zellij's built-in horizontal tab bar shows the static title only.

## Status protocol

The extension broadcasts version 1 JSON through `zellij pipe --name pi_status`. A snapshot has this shape:

```json
{
  "v": 1,
  "kind": "snapshot",
  "runtime_id": "2b73...",
  "seq": 4,
  "pane_id": 248,
  "mode": "working"
}
```

`mode` is `base`, `working`, `compacting`, or `done`. Active `working`, `compacting`, and `done` snapshots are replayed with the same sequence number; existing sidebars ignore the duplicate while new sidebars accept it. Shutdown sends `kind: "remove"` with the same identity fields and no mode. Messages contain no prompt, command, cwd, tool argument, or conversation content.

## Development

Run the deterministic regression suite:

```bash
npm test
npm run test:coverage
npm run eval
```

CI enforces at least 95% aggregate line, branch, and function coverage across `pi-extension.ts` and `lib/*.ts`. The eval wrapper runs every test file, records no model output, and makes no network calls. Keep the status protocol synchronized with `zellij-tabbar` when changing message fields or lifecycle semantics.

### Live smoke and E2E tests

On Linux, install PI, Zellij, Node.js 24+, Python 3, Git, and util-linux's `script` command, then run:

```bash
npm run test:smoke
npm run test:e2e
```

Each test starts a real PI TUI in a separate Zellij session with temporary configuration and no inherited credentials. These extension tests verify lifecycle handling, successful pipe publication, static title behavior, and cleanup. The `zellij-tabbar` repository's isolated live smoke test verifies status rendering, local animation, background completion, and clearing on view with the real WASM plugin.

### Structure

- `pi-extension.ts` registers lifecycle handlers.
- `controller.ts` coalesces lifecycle changes, replays active status for new sidebars, maintains the static title, and orders shutdown.
- `tab-binding.ts` owns binding retries and title caching.
- `ownership.ts` parses pane/tab data and selects the owner. `zellij.ts` reads Zellij state and writes static titles.
- `activity.ts` owns parent, child, and compaction transitions. `subagent-jobs.ts` adapts named-agent results and reads idle completions.
- `status-model.ts` retains marker parsing compatibility for old titles; `tab-title.ts` derives Git/directory titles. `commands.ts` keeps stdout-reading commands captured, while `status-transport.ts` serializes status pipes with ignored stdio and a 150 ms deadline.

## License

MIT
