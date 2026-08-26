#!/usr/bin/env python3
"""Run deterministic component evals for the Zellij PI tab-status extension."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    repo = Path(__file__).resolve().parents[2]
    cases_path = Path(__file__).with_name("cases.json")
    cases = json.loads(cases_path.read_text(encoding="utf-8"))["cases"]

    result = subprocess.run(
        ["node", "--test", "test/pi-extension.test.mjs"],
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )

    missing = [case["id"] for case in cases if case["expected_test"] not in result.stdout]
    if result.returncode != 0 or missing:
        sys.stdout.write(result.stdout)
        if missing:
            print(f"Missing expected eval cases in test output: {', '.join(missing)}", file=sys.stderr)
        return 1

    print(f"PASS: {len(cases)} deterministic tab-status cases (layers 1-2, public fixtures)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
