"""Tiny HTTP API around the gluetun control server.

GET  /health  -> liveness, no auth
GET  /ip      -> current Proton exit IP + location
POST /rotate  -> reconnect to a (random) other Proton server until the exit IP changes,
                 and by default until it lands in a different subnet (/24 for IPv4)
"""

import hmac
import ipaddress
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GLUETUN_URL = os.environ.get("GLUETUN_URL", "http://gluetun:8000").rstrip("/")
GLUETUN_API_KEY = os.environ["GLUETUN_API_KEY"]
ROTATOR_API_KEY = os.environ["ROTATOR_API_KEY"]
MAX_ATTEMPTS = int(os.environ.get("ROTATE_MAX_ATTEMPTS", "6"))
ATTEMPT_TIMEOUT = float(os.environ.get("ROTATE_ATTEMPT_TIMEOUT", "30"))
REQUIRE_NEW_SUBNET = os.environ.get("ROTATE_REQUIRE_NEW_SUBNET", "on") == "on"
SUBNET_PREFIX_V4 = int(os.environ.get("ROTATE_SUBNET_PREFIX_V4", "24"))
SUBNET_PREFIX_V6 = int(os.environ.get("ROTATE_SUBNET_PREFIX_V6", "64"))
POLL_INTERVAL = 1.0
REQUEST_TIMEOUT = 10

rotate_lock = threading.Lock()


class GluetunError(Exception):
    pass


def gluetun(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        GLUETUN_URL + path,
        data=data,
        method=method,
        headers={"X-API-Key": GLUETUN_API_KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        raise GluetunError(f"{method} {path} failed: {exc}") from exc
    return json.loads(raw) if raw else {}


def current_ip() -> dict:
    return gluetun("GET", "/v1/publicip/ip")


def set_vpn_status(status: str) -> None:
    gluetun("PUT", "/v1/vpn/status", {"status": status})


def wait_for_new_ip(old_ip: str) -> dict | None:
    deadline = time.monotonic() + ATTEMPT_TIMEOUT
    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL)
        try:
            info = current_ip()
        except GluetunError:
            continue
        ip = info.get("public_ip")
        if ip and ip != old_ip:
            return info
    return None


def subnet_of(ip: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network | None:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return None
    prefix = SUBNET_PREFIX_V4 if addr.version == 4 else SUBNET_PREFIX_V6
    return ipaddress.ip_network(f"{addr}/{prefix}", strict=False)


def in_new_subnet(old_ip: str, new_ip: str) -> bool:
    old_net = subnet_of(old_ip)
    return old_net is None or ipaddress.ip_address(new_ip) not in old_net


def rotate() -> dict:
    old_ip = current_ip().get("public_ip", "")
    last_ip = old_ip
    last_info = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        set_vpn_status("stopped")
        set_vpn_status("running")
        info = wait_for_new_ip(last_ip)
        if not info:
            continue
        last_ip, last_info = info["public_ip"], info
        new_subnet = in_new_subnet(old_ip, last_ip)
        if new_subnet or not REQUIRE_NEW_SUBNET:
            return {"old_ip": old_ip, "attempts": attempt, "new_subnet": new_subnet, **info}
    if last_info:
        # IP changed, but every server we got was in the old subnet: still better than nothing
        return {"old_ip": old_ip, "attempts": MAX_ATTEMPTS, "new_subnet": False, **last_info}
    raise GluetunError(f"exit IP did not change after {MAX_ATTEMPTS} attempts")


class Handler(BaseHTTPRequestHandler):
    server_version = "protonvpn-rotator"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        key = self.headers.get("X-API-Key", "")
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            key = auth.removeprefix("Bearer ")
        return hmac.compare_digest(key.encode(), ROTATOR_API_KEY.encode())

    def _handle(self, routes: dict) -> None:
        if self.path == "/health":
            self._send(200, {"status": "ok"})
            return
        action = routes.get(self.path)
        if action is None:
            self._send(404, {"error": "not found"})
            return
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        try:
            self._send(200, action())
        except GluetunError as exc:
            self._send(502, {"error": str(exc)})

    def do_GET(self) -> None:
        self._handle({"/ip": current_ip})

    def do_POST(self) -> None:
        self._handle({"/rotate": self._rotate_exclusive})

    def _rotate_exclusive(self) -> dict:
        if not rotate_lock.acquire(blocking=False):
            raise GluetunError("rotation already in progress")
        try:
            return rotate()
        finally:
            rotate_lock.release()

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
