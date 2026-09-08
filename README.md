# zellij-pi-tab-status

A PI extension that shows agent activity in the Zellij tab that owns the PI pane.

While PI works, the tab name gets an animated spinner. When the full run settles in a background tab, the tab gets a `●` marker until you view it. The extension restores the descriptive base title when the tab becomes active or PI shuts down.

## Install

Add the Git package to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/pbjorklund/zellij-pi-tab-status"
  ]
}
```

Then run `pi update` or restart PI and approve package installation when prompted.

## Behavior

- Runs only in PI's TUI inside Zellij.
- Finds the owning tab from `ZELLIJ_PANE_ID`, pane working directory, and Zellij application state. When the pane moves, removes its old overlay only if that tab's title has not been changed by someone else.
- Uses `repository/path:branch` for Git worktrees and the directory name elsewhere.
- Keeps the working spinner running while the parent agent or tracked subagents are working.
- Caches the tab binding and Git title, so spinner frames need only the rename command.
- Runs status updates in the background without blocking lifecycle hooks. Repeated subagent starts do not add commands or reset the spinner while the caches are fresh.
- Waits 500 ms after each spinner update before scheduling the next, so slow commands cannot build a backlog.
- Polls unviewed done tabs with exponential backoff to stay responsive without spawning constantly.
- Keeps work marked across automatic retries, queued follow-ups, and compaction recovery.
- Animates `◐ ◓ ◑ ◒` during manual and automatic compaction, then restores the correct state after success, failure, or cancellation.
- Marks inactive tabs with `●` once the parent has settled and all tracked subagents have finished. Preserves completion received during compaction.
- Restores the base name when the tab is viewed, on user input, or during shutdown.
- Treats Zellij commands as best effort, so tab-status failures do not interrupt PI.

Subagent tracking supports both the `subagents:started` / `subagents:completed` / `subagents:failed` event bus (payload: `{ id }`) and the `@narumitw/pi-subagents` job API (`subagent_spawn`, `subagent_wait`, `subagent_cancel`, and `subagent_inspect` results). For the job API, it reads new `pi-subagents-completion` entries from in-memory session history every 500 ms while jobs are active. This also catches completions while the main agent is idle, without spawning processes or reading session files.

The extension needs PI 0.84.3 or newer and a Zellij version that provides `list-panes`, `list-tabs`, and `rename-tab-by-id` actions.

## Development

Run the deterministic regression suite:

```bash
npm test
npm run test:coverage
npm run eval
```

CI enforces at least 95% aggregate line, branch, and function coverage across `pi-extension.ts` and `lib/*.ts`. This measures the unit and integration tests together, not live E2E coverage. Test fixtures are not production source.

The eval wrapper runs every test file, records no model output, and makes no network calls. Tests cover title derivation (including real temporary Git worktrees), tab ownership, lifecycle handling, command counts, and non-Zellij guards. Lifecycle tests share their setup, mock timers, and stalled-command fixtures to check polling backoff, event bursts, and shutdown races without wall-clock sleeps. Public-API and Git-title tests run in separate files.

### Live smoke and E2E tests

On Linux, install PI, Zellij, Node.js 24+, Python 3, Git, and util-linux's `script` command, then run:

```bash
npm run test:smoke
npm run test:e2e
```

CI runs both commands with PI 0.85.1 and Zellij 0.45.0. Missing executables fail the tests; they are not skipped.

Each test starts a real PI TUI in a separate Zellij session with a temporary Git repository, HOME, and config. The runner passes no inherited credentials or user settings, addresses only its own session, and cleans up after success or failure. No model API calls are made.

The smoke test checks advancing work frames, completion in a background tab, clearing on view, and title restoration when PI exits. The full suite also checks a modern child job that outlives its parent, legacy child completion during compaction, and cancelled compaction. Every title check also verifies that the control tab is unchanged.

PI dispatches the real tool, lifecycle, compaction, and session-history events; Zellij performs the actual tab writes. `e2e/fixture.ts` supplies local model responses, child-protocol payloads, and compaction results/cancellation. These tests do not run an external model or the installed subagent package. The Python runner has separate cleanup regression tests.

### Structure

`pi-extension.ts` registers lifecycle handlers. The modules separate state, scheduling, and command execution:

- `controller.ts` coalesces updates, schedules animation and polling, and orders teardown.
- `tab-binding.ts` owns binding retries and the title cache.
- `ownership.ts` parses pane/tab data and selects the owner without running commands. `zellij.ts` reads Zellij state and handles rename retries and overlay cleanup.
- `activity.ts` owns parent, child, and compaction transitions. `subagent-jobs.ts` adapts the job API and reads idle completions.
- `status-model.ts` formats markers; `tab-title.ts` derives Git/directory titles; `commands.ts` bounds command execution.

All modules live in `lib/`. Public exports remain in `pi-extension.ts`.

## License

MIT
