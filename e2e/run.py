"""Black-box PI/Zellij tests. Requires Linux, Python, git, pi, script, and Zellij."""

import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
WORKING = re.compile(r"^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] repo:main$")
COMPACTING = re.compile(r"^[◐◓◑◒] repo:main$")


class LiveTabStatus(unittest.TestCase):
    def setUp(self):
        for command in ("pi", "zellij", "git", "script"):
            self.assertIsNotNone(shutil.which(command), f"Install {command} to run live E2E tests")
        # Keep Zellij's Unix socket path below the platform length limit.
        self.directory = tempfile.TemporaryDirectory(prefix="zpts-", dir="/tmp")
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.repo = self.home / "repo"
        self.repo.mkdir()
        self.session = "tab-status-e2e-" + uuid.uuid4().hex[:12]
        # No inherited credentials, PI config, Zellij session, or shell startup files.
        self.env = {
            "PATH": os.environ["PATH"], "HOME": str(self.home), "SHELL": "/bin/sh",
            "TERM": "xterm-256color", "LANG": "C.UTF-8",
            "XDG_CONFIG_HOME": str(self.home / "config"),
            "XDG_CACHE_HOME": str(self.home / "cache"),
            "XDG_DATA_HOME": str(self.home / "data"),
            "XDG_RUNTIME_DIR": str(self.home / "run"),
            "PI_CODING_AGENT_DIR": str(self.home / "agent"),
            "PI_OFFLINE": "1", "PI_TELEMETRY": "0", "TAB_STATUS_E2E_DIR": str(self.home),
        }
        (self.home / "run").mkdir(mode=0o700)
        (self.home / "agent").mkdir()
        (self.home / "agent/settings.json").write_text(json.dumps({
            "quietStartup": True, "compaction": {"enabled": False, "keepRecentTokens": 1},
            "retry": {"enabled": False},
        }))
        self.run_command(["git", "init", "-b", "main", str(self.repo)])
        config = self.home / "config.kdl"
        config.write_text('on_force_close "quit"\nsession_serialization false\nshow_startup_tips false\nshow_release_notes false\n')
        args = [
            "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates",
            "--no-context-files", "--no-themes", "--no-builtin-tools", "--no-session",
            "--extension", str(ROOT / "pi-extension.ts"),
            "--extension", str(ROOT / "e2e/fixture.ts"),
            "--provider", "tab-status-fixture", "--model", "fixture", "--thinking", "off",
            "--system-prompt", "This is an offline deterministic test.",
        ]
        command = ["zellij", "--config", str(config), "--session", self.session]
        self.terminal = self.home / "terminal.log"
        log = self.terminal.open("wb")
        self.addCleanup(log.close)
        self.client = subprocess.Popen(
            ["script", "-qefc", "stty rows 40 cols 120; exec " + shlex.join(command), "/dev/null"],
            stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
            env=self.env, cwd=self.repo, start_new_session=True,
        )
        self.addCleanup(self.stop_session)
        def started():
            result = self.run_command(["zellij", "--session", self.session, "action", "list-tabs", "--json", "--state"], check=False)
            tabs = json.loads(result.stdout) if result.returncode == 0 and result.stdout.startswith("[") else []
            return tabs if any(tab["active"] for tab in tabs) else None
        tabs = self.wait(started, "Zellij client startup")
        self.action("rename-tab-by-id", str(tabs[0]["tab_id"]), "control")
        self.tab = int(self.action("new-tab", "--name", "subject", "--cwd", str(self.repo), "--", shutil.which("pi"), *args).strip())
        self.wait(lambda: (self.home / "session-started").exists(), "PI session startup")
        pane = self.wait(lambda: next((p for p in self.panes() if p["tab_id"] == self.tab and not p["is_plugin"]), None), "PI pane")
        self.pane = str(pane["id"])
        self.wait_name(lambda name: name == "repo:main", "initial title")

    def run_command(self, args, check=True):
        result = subprocess.run(args, env=self.env, cwd=self.repo, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        if check and result.returncode:
            self.fail(f"Command failed: {args!r}\n{result.stderr}\n{result.stdout}")
        return result

    def action(self, *args):
        return self.run_command(["zellij", "--session", self.session, "action", *args]).stdout

    def panes(self):
        output = self.action("list-panes", "--all", "--json")
        return json.loads(output) if output.strip() else []

    def tab_name(self):
        output = self.action("list-tabs", "--json", "--state")
        if not output.strip():
            return None
        tabs = json.loads(output)
        self.assertTrue(any(tab["name"] == "control" for tab in tabs), "Unrelated tab was renamed")
        return next(tab["name"] for tab in tabs if tab["tab_id"] == self.tab)

    def wait(self, condition, description, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = condition()
            if value:
                return value
            if self.client.poll() is not None:
                break
            time.sleep(0.05)
        screen = self.action("dump-screen", "--full") if self.client.poll() is None else ""
        tail = self.terminal.read_bytes()[-6000:].decode(errors="replace")
        self.fail(f"Timed out waiting for {description}. Screen: {screen!r}. Terminal tail: {tail!r}")

    def wait_name(self, predicate, description):
        return self.wait(lambda: name if (name := self.tab_name()) is not None and predicate(name) else None, description)

    def animated(self, pattern):
        first = self.wait_name(pattern.fullmatch, "first animation frame")
        self.wait_name(lambda name: name != first and pattern.fullmatch(name), "next animation frame")

    def send(self, text):
        self.action("write-chars", "--pane-id", self.pane, text)
        self.action("write", "--pane-id", self.pane, "13")

    def mark(self, name):
        (self.home / name).touch()

    def settled(self):
        self.wait(lambda: (self.home / "parent-settled").exists(), "real agent_settled event")

    def stop_session(self):
        try:
            self.run_command(["zellij", "kill-session", self.session], check=False)
        finally:
            try:
                self.client.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.client.pid, signal.SIGKILL)
                self.client.communicate(timeout=3)

    def test_parent_completion_seen_and_shutdown(self):
        self.send("hold")
        self.animated(WORKING)
        self.action("go-to-tab-name", "control")
        self.mark("release-parent")
        self.settled()
        self.wait_name(lambda name: name == "● repo:main", "unseen completion")
        self.action("go-to-tab-by-id", str(self.tab))
        self.wait_name(lambda name: name == "repo:main", "viewed completion clears")
        self.send("/fixture legacy-start")
        self.animated(WORKING)
        self.send("/fixture shutdown")
        self.wait(lambda: (self.home / "shutdown").exists(), "real session_shutdown event")
        self.wait_name(lambda name: name == "repo:main", "shutdown restores title")
        self.wait(lambda: any(str(p["id"]) == self.pane and p["exited"] for p in self.panes()), "PI process exit")

    def test_modern_child_outlives_parent(self):
        self.send("spawn")
        self.settled()
        self.animated(WORKING)
        self.action("go-to-tab-name", "control")
        self.send("/fixture modern-complete")
        self.wait_name(lambda name: name == "● repo:main", "idle custom completion reaches observer")
        self.action("go-to-tab-by-id", str(self.tab))
        self.wait_name(lambda name: name == "repo:main", "viewed child completion clears")

    def test_legacy_completion_during_compaction(self):
        self.send("seed")
        self.settled()
        self.send("/fixture legacy-start")
        self.animated(WORKING)
        self.send("/compact")
        self.animated(COMPACTING)
        self.action("go-to-tab-name", "control")
        self.mark("complete-legacy")
        self.mark("release-compaction")
        self.wait(lambda: (self.home / "compacted").exists(), "real session_compact event")
        self.wait_name(lambda name: name == "● repo:main", "completion preserved through compaction")

    def test_cancelled_compaction_restores_idle(self):
        self.send("seed")
        self.settled()
        self.send("/compact")
        self.animated(COMPACTING)
        self.mark("cancel-compaction")
        self.mark("release-compaction")
        self.wait(lambda: (self.home / "compaction-failed").exists(), "real session_compact_failed event")
        self.wait_name(lambda name: name == "repo:main", "cancelled compaction clears overlay")


if __name__ == "__main__":
    unittest.main(verbosity=2)
