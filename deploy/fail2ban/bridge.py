#!/usr/bin/env python3
"""
Vibe fail2ban bridge.

fail2ban's control socket is root-only (it sets umask 077). This tiny relay runs next to fail2ban, listens on a
socket that only Vibe's group can use, and forwards a strict allow-list of commands:

    ["ping"]                         health check
    ["status"]                       jail list
    ["status", <jail>]               one jail: failures and banned IPs
    ["set", <jail>, "banip"|"unbanip", <ip or CIDR>]

Requests are decoded with an unpickler that refuses every class (plain lists of strings only), so a compromised
Vibe can't use the bridge for anything beyond these commands.
"""
import io
import ipaddress
import os
import pickle
import re
import socket
import socketserver
import sys

END = b"<F2B_END_COMMAND>"
F2B_SOCKET = os.environ.get("F2B_SOCKET", "/var/run/fail2ban/fail2ban.sock")
BRIDGE_SOCKET = os.environ.get("BRIDGE_SOCKET", "/run/mediamax-f2b/bridge.sock")
BRIDGE_GID = int(os.environ.get("BRIDGE_GID", "1000"))
JAIL = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


class DataOnly(pickle.Unpickler):
    def find_class(self, module, name):  # noqa: D401 - refuse everything
        raise pickle.UnpicklingError(f"refused {module}.{name}")


def allowed(cmd):
    if not isinstance(cmd, list) or not all(isinstance(x, str) for x in cmd):
        return False
    if cmd in (["ping"], ["status"]):
        return True
    if len(cmd) == 2 and cmd[0] == "status" and JAIL.match(cmd[1]):
        return True
    if len(cmd) == 4 and cmd[0] == "set" and JAIL.match(cmd[1]) and cmd[2] in ("banip", "unbanip"):
        try:
            net = ipaddress.ip_network(cmd[3], strict=False)
        except ValueError:
            return False
        # Same floor as Vibe's own check: never a range wider than /8 (IPv4) or /16 (IPv6), so a compromised
        # Vibe can't ban the whole internet (0.0.0.0/0) and lock everyone out, the operator included.
        return net.prefixlen >= (8 if net.version == 4 else 16)
    return False


def ask_fail2ban(cmd):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(10)
        s.connect(F2B_SOCKET)
        s.sendall(pickle.dumps(cmd, 2) + END)
        buf = b""
        while END not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
            if len(buf) > 4 * 1024 * 1024:
                raise RuntimeError("reply too large")
        return buf.split(END)[0]


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(10)
        buf = b""
        while END not in buf:
            chunk = self.request.recv(65536)
            if not chunk:
                return
            buf += chunk
            if len(buf) > 65536:
                return
        try:
            cmd = DataOnly(io.BytesIO(buf.split(END)[0])).load()
        except Exception:
            cmd = None
        if not allowed(cmd):
            reply = pickle.dumps((1, "ERROR: command not allowed by the Vibe bridge"), 2)
        elif cmd == ["ping"]:
            reply = pickle.dumps((0, "pong"), 2)
        else:
            try:
                reply = ask_fail2ban(cmd)
            except Exception as e:  # fail2ban down, socket missing…
                reply = pickle.dumps((1, f"ERROR: fail2ban unavailable: {e}"), 2)
        self.request.sendall(reply + END)


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def main():
    os.makedirs(os.path.dirname(BRIDGE_SOCKET), exist_ok=True)
    try:
        os.unlink(BRIDGE_SOCKET)
    except FileNotFoundError:
        pass
    old = os.umask(0o117)
    srv = Server(BRIDGE_SOCKET, Handler)
    os.umask(old)
    os.chown(BRIDGE_SOCKET, 0, BRIDGE_GID)
    os.chmod(BRIDGE_SOCKET, 0o660)
    print(f"mediamax fail2ban bridge: {BRIDGE_SOCKET} (gid {BRIDGE_GID}) -> {F2B_SOCKET}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
