# zellij-pi-tab-status

A PI extension that shows agent activity in the Zellij tab that owns the PI pane.

While PI works, the tab name gets a `⠋` marker. When the full run settles in a background tab, the tab gets a `●` marker until you view it. The extension restores the descriptive base title when the tab becomes active or PI shuts down.

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
- Keeps the working marker active while the parent agent or tracked subagents are working.
- Keeps work marked across automatic retries, queued follow-ups, and compaction recovery.
- Clears the marker during compaction, then restores the correct state after success or failure.
- Marks completed work in inactive tabs with `●` only after PI emits `agent_settled`.
- Restores the base name when the tab is viewed, on user input, or during shutdown.
- Treats Zellij commands as best effort, so tab-status failures do not interrupt PI.

The extension needs PI 0.84.3 or newer and a Zellij version that provides `list-panes`, `list-tabs`, and `rename-tab-by-id` actions.

## Development

Run the deterministic regression suite:

```bash
npm test
npm run eval
```

The eval wrapper records no model output and makes no network calls. It verifies title derivation, tab ownership, lifecycle handling, and non-Zellij guards through the Node test suite.

## License

MIT
