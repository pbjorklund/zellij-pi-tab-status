import json
import subprocess
import unittest
from unittest.mock import Mock, patch

import run as live_runner


class RunnerSnapshots(unittest.TestCase):
    def test_empty_snapshots_wait_for_another_poll(self):
        case = live_runner.LiveTabStatus()
        case.tab = 2
        case.action = Mock(side_effect=["", "", '[{"tab_id":1,"name":"control"},{"tab_id":2,"name":"repo:main"}]'])
        self.assertIsNone(case.tab_name())
        self.assertEqual(case.panes(), [])
        self.assertEqual(case.tab_name(), "repo:main")

    def test_malformed_snapshots_still_fail(self):
        case = live_runner.LiveTabStatus()
        case.action = Mock(return_value="not JSON")
        with self.assertRaises(json.JSONDecodeError):
            case.tab_name()

    def test_renamed_control_tab_still_fails(self):
        case = live_runner.LiveTabStatus()
        case.tab = 2
        case.action = Mock(return_value='[{"tab_id":1,"name":"wrong"},{"tab_id":2,"name":"repo:main"}]')
        with self.assertRaisesRegex(AssertionError, "Unrelated tab was renamed"):
            case.tab_name()


class RunnerCleanup(unittest.TestCase):
    def test_reaps_client_when_session_stop_times_out(self):
        case = live_runner.LiveTabStatus()
        case.session = "fixture-session"
        case.client = Mock()
        case.run_command = Mock(side_effect=subprocess.TimeoutExpired("zellij", 5))
        with self.assertRaises(subprocess.TimeoutExpired):
            case.stop_session()
        case.client.communicate.assert_called_once_with(timeout=3)

    def test_kills_and_reaps_a_stalled_client(self):
        case = live_runner.LiveTabStatus()
        case.session = "fixture-session"
        case.client = Mock(pid=12345)
        case.client.communicate.side_effect = [subprocess.TimeoutExpired("script", 3), (None, None)]
        case.run_command = Mock()
        with patch("run.os.killpg") as kill:
            case.stop_session()
        kill.assert_called_once_with(12345, 9)
        self.assertEqual(case.client.communicate.call_count, 2)
