"""Tests for the fail2ban bridge allow-list:  python3 deploy/fail2ban/test_bridge.py"""
import importlib.util
import os
import unittest

spec = importlib.util.spec_from_file_location("bridge", os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class AllowListTest(unittest.TestCase):
    def test_plain_commands(self):
        self.assertTrue(bridge.allowed(["ping"]))
        self.assertTrue(bridge.allowed(["status"]))
        self.assertTrue(bridge.allowed(["status", "mediamax"]))
        self.assertFalse(bridge.allowed(["status", "../x"]))
        self.assertFalse(bridge.allowed(["stop"]))
        self.assertFalse(bridge.allowed("ping"))

    def test_ban_addresses_and_ranges(self):
        for ip in ("203.0.113.9", "203.0.113.0/24", "10.0.0.0/8", "2001:db8::1", "2001:db8::/32"):
            self.assertTrue(bridge.allowed(["set", "mediamax", "banip", ip]), ip)
        for ip in ("0.0.0.0/0", "128.0.0.0/1", "10.0.0.0/7", "::/0", "2000::/3", "2001::/15", "not-an-ip", "1.2.3.4; rm -rf /"):
            self.assertFalse(bridge.allowed(["set", "mediamax", "banip", ip]), ip)
            self.assertFalse(bridge.allowed(["set", "mediamax", "unbanip", ip]), ip)
        self.assertFalse(bridge.allowed(["set", "mediamax", "addignoreip", "203.0.113.9"]))


if __name__ == "__main__":
    unittest.main()
