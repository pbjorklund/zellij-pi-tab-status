# zellij-pi-tab-status

A PI extension that shows agent activity in the Zellij tab that owns the PI pane.

While PI works, the tab name gets a spinner. When work finishes in a background tab, the tab gets a `●` marker until you view it. The extension restores the descriptive base title when the tab becomes active or PI shuts down.

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
- Keeps the spinner active while the parent agent or tracked subagents are working.
- Clears animation during compaction and resumes it when PI retries.
- Marks completed work in inactive tabs with `●`.
- Restores the base name when the tab is viewed, on user input, or during shutdown.
- Treats Zellij commands as best effort, so tab-status failures do not interrupt PI.

The extension needs a Zellij version that provides `list-panes`, `list-tabs`, and `rename-tab-by-id` actions.

## Development

Run the deterministic regression suite:

```bash
npm test
npm run eval
```

The eval wrapper records no model output and makes no network calls. It verifies the title, ownership, activity, and non-Zellij guard behavior through the Node test suite.

## License

MIT
