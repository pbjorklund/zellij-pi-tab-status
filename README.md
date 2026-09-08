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
- Finds the owning tab from `ZELLIJ_PANE_ID`, pane working directory, and Zellij application state.
- Uses `repository/path:branch` for Git worktrees and the directory name elsewhere.
- Keeps the working spinner running while the parent agent or tracked subagents are working.
- Caches the tab binding and Git title, so spinner frames need only the rename command.
- Runs status updates in the background without blocking lifecycle hooks. Repeated subagent starts do not add commands or reset the spinner while the caches are fresh.
- Waits 500 ms after each spinner update before scheduling the next, so slow commands cannot build a backlog.
- Polls unviewed done tabs with exponential backoff to stay responsive without spawning constantly.
- Keeps work marked across automatic retries, queued follow-ups, and compaction recovery.
- Animates `◐ ◓ ◑ ◒` during manual and automatic compaction, then restores the correct state after success, failure, or cancellation.
- Marks completed work in inactive tabs with `●` only after PI emits `agent_settled`.
- Restores the base name when the tab is viewed, on user input, or during shutdown.
- Treats Zellij commands as best effort, so tab-status failures do not interrupt PI.

Subagent tracking supports both the `subagents:started` / `subagents:completed` / `subagents:failed` event bus (payload: `{ id }`) and the `@narumitw/pi-subagents` job API (`subagent_spawn`, `subagent_wait`, `subagent_cancel`, and `subagent_inspect` results). For the job API, it reads new `pi-subagents-completion` entries from in-memory session history every 500 ms while jobs are active. This also catches completions while the main agent is idle, without spawning processes or reading session files.

The extension needs PI 0.84.3 or newer and a Zellij version that provides `list-panes`, `list-tabs`, and `rename-tab-by-id` actions.

## Development

Run the deterministic regression suite:

```bash
npm test
npm run eval
```

The eval wrapper runs every test file, records no model output, and makes no network calls. Tests cover title derivation (including real temporary Git worktrees), tab ownership, lifecycle handling, command counts, and non-Zellij guards. Mock timers and stalled-command fixtures check polling backoff, event bursts, and shutdown races without wall-clock sleeps.

`pi-extension.ts` registers lifecycle handlers. `lib/controller.ts` schedules writes and teardown. `lib/tab-binding.ts` owns binding retries and the title cache. `lib/subagent-jobs.ts` adapts the job API without coupling its payload format to the scheduler. The other `lib/` modules handle commands, ownership, title derivation, and work tracking.

## License

MIT
