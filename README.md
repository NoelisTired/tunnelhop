# protonvpn-proxy

Local HTTP(S) proxy whose outbound traffic leaves via ProtonVPN, plus an API to
rotate to a new Proton exit IP. Only traffic you send through the proxy goes via
Proton; the host and everything else keeps its normal connection.

```
scraper ──► 127.0.0.1:8888 (HTTP proxy) ──► gluetun ══ WireGuard ══► Proton ──► internet
you     ──► 127.0.0.1:8081 (rotator API) ──► gluetun control API (reconnect)
```

- **gluetun** (`qmcgaw/gluetun`): the VPN tunnel, built-in kill switch (if the
  tunnel is down, proxy traffic is blocked instead of leaking via your own IP).
- **rotator**: small Python service (stdlib only) for `GET /ip` and `POST /rotate`.

## Setup

1. `./setup.sh` creates `.env` with random secrets and `gluetun/auth/config.toml`.
2. Put your Proton credentials in `.env`:
   - WireGuard (recommended): account.proton.me > Downloads > WireGuard
     configuration, generate a config, copy the `PrivateKey` into
     `WIREGUARD_PRIVATE_KEY`.
   - Or OpenVPN: `VPN_TYPE=openvpn` + the OpenVPN/IKEv2 username and password
     (not your Proton login).
3. Pick the server pool with `SERVER_COUNTRIES` (comma-separated).
4. `docker compose up -d --build`

## Usage

```sh
# proxy (credentials: PROXY_USER / PROXY_PASSWORD from .env)
curl -x http://scraper:PASSWORD@127.0.0.1:8888 https://api.ipify.org

# current exit IP
curl -H "X-API-Key: $ROTATOR_API_KEY" http://127.0.0.1:8081/ip

# new IP (stops + restarts the tunnel on a random server from the pool, ~5-15s)
curl -X POST -H "X-API-Key: $ROTATOR_API_KEY" http://127.0.0.1:8081/rotate
```

Python example:

```python
import requests
proxies = {"http": "http://scraper:PASSWORD@127.0.0.1:8888",
           "https": "http://scraper:PASSWORD@127.0.0.1:8888"}
requests.get("https://example.com", proxies=proxies, timeout=30)
requests.post("http://127.0.0.1:8081/rotate", headers={"X-API-Key": KEY}, timeout=120)
```

A scraper running in Docker can also skip the proxy and share the tunnel
directly with `network_mode: "service:gluetun"`.

## Notes

- During a rotation (a few seconds) requests through the proxy fail. Pause your
  scraper, or retry, around `/rotate`. Concurrent rotate calls get a 502.
- Rotation picks a random server from the pool and retries if the IP stays the
  same (`ROTATE_MAX_ATTEMPTS`). A bigger pool (more countries) gives more variety.
- One container = one exit IP at a time. For parallel IPs, run multiple gluetun
  instances (each counts as one Proton device).
- `BIND_ADDR=127.0.0.1` keeps the ports local. Set it to your LAN IP to use the
  proxy from other devices.
- `LAN_SUBNETS` (e.g. `192.168.1.0/24`) lets tunnelled traffic still reach your LAN.
