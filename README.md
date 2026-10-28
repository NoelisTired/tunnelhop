<p align="center">
  <img src="assets/banner.svg" alt="tunnelhop: rotate VPN exit IPs from one local proxy" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-a3e635?style=flat-square"></a>
  <img alt="Docker Compose" src="https://img.shields.io/badge/docker-compose-5b21b6?style=flat-square&logo=docker&logoColor=white">
  <img alt="ProtonVPN via gluetun" src="https://img.shields.io/badge/ProtonVPN-WireGuard-1e1b4b?style=flat-square">
  <img alt="Zero host config" src="https://img.shields.io/badge/host%20network-untouched-5eead4?style=flat-square">
</p>

**tunnelhop** gives you one local HTTP(S) proxy whose traffic leaves the internet
through a ProtonVPN server, plus a tiny API to hop to a fresh exit IP whenever you
want. Everything runs in Docker. Your machine, your browser and every other app
keep using your normal connection.

```sh
curl -x http://scraper:PASSWORD@127.0.0.1:8888 https://api.ipify.org   # 149.88.24.7  (VPN)
curl -X POST -H "X-API-Key: $KEY" http://127.0.0.1:8081/rotate          # hop to a new server
curl -x http://scraper:PASSWORD@127.0.0.1:8888 https://api.ipify.org   # 205.147.16.138 (new IP, new /24)
curl https://api.ipify.org                                              # your own IP, unchanged
```

---

## Why

Running a VPN client on your machine is all-or-nothing: every app goes through
the tunnel, LAN access gets weird, and switching servers means clicking around in
a GUI. That is the wrong shape for scraping, data collection, geo-testing or QA,
where you want **one program** to come from a different IP and **everything
else** to stay normal.

tunnelhop turns a VPN subscription into a programmable proxy:

| | VPN app on your machine | tunnelhop |
|---|---|---|
| Scope | Whole machine | Only what you send through the proxy |
| Switch IP | Manual, in a GUI | `POST /rotate`, from code |
| Guaranteed new subnet | No | Yes, keeps hopping until the /24 changes |
| Leak if the tunnel drops | Depends on settings | Blocked by the built-in kill switch |
| LAN / localhost | Often broken | Untouched |
| Automatable / headless | Rarely | Docker, two ports, a JSON API |

## How it works

```mermaid
flowchart LR
    subgraph host["Your machine (normal connection)"]
        S["Scraper / script"]
        B["Browser, other apps"]
    end
    subgraph docker["Docker"]
        G["gluetun<br/>WireGuard + kill switch<br/>HTTP proxy :8888"]
        R["rotator<br/>:8081"]
    end
    S -- "HTTP(S) via proxy" --> G
    S -- "POST /rotate" --> R
    R -- "control API (API key)" --> G
    G == "WireGuard tunnel" ==> P["ProtonVPN server"] --> I(("Internet"))
    B --> I
```

- **[gluetun](https://github.com/qdm12/gluetun)** holds the WireGuard tunnel to
  ProtonVPN, runs the HTTP proxy, and has a firewall kill switch: if the tunnel is
  down, proxied traffic is dropped instead of falling back to your real IP.
- **rotator** is a ~160-line Python service (standard library only) that talks to
  gluetun's authenticated control API. `POST /rotate` restarts the tunnel on a
  random server from your pool and only returns once the exit IP has actually
  changed **and** sits in a different /24 than before, because many sites block
  per subnet, not per address.
- Both ports bind to `127.0.0.1` by default. Nothing is exposed to your network
  unless you choose to.

## Quick start

Requirements: Docker (with Compose v2) and a ProtonVPN account (paid plans give
you all countries; free works with `FREE_ONLY=on`).

```sh
git clone https://github.com/NoelisTired/tunnelhop ~/tunnelhop
cd ~/tunnelhop
./setup.sh          # creates .env with random secrets + the gluetun auth file
```

Get a WireGuard key: **account.proton.me > Downloads > WireGuard configuration**.
Pick platform *GNU/Linux*, leave NAT-PMP and Moderate NAT off, choose any server,
click **Create** and copy the value after `PrivateKey =` into `.env`:

```sh
WIREGUARD_PRIVATE_KEY=your-key-here
SERVER_COUNTRIES=Netherlands,Belgium,Germany
```

One key works for every Proton server. Then:

```sh
docker compose up -d --build
```

Your proxy is at `http://127.0.0.1:8888` (user/password: `PROXY_USER` /
`PROXY_PASSWORD` in `.env`), the rotator at `http://127.0.0.1:8081`
(key: `ROTATOR_API_KEY`).

## Usage

### Python

```python
import requests

PROXY = "http://scraper:PASSWORD@127.0.0.1:8888"
ROTATOR = "http://127.0.0.1:8081"
KEY = "your-rotator-key"

s = requests.Session()
s.proxies = {"http": PROXY, "https": PROXY}

for url in urls:
    r = s.get(url, timeout=30)
    if r.status_code in (403, 429):
        requests.post(f"{ROTATOR}/rotate", headers={"X-API-Key": KEY}, timeout=300)
        r = s.get(url, timeout=30)
```

### Playwright

```python
browser = p.chromium.launch(proxy={
    "server": "http://127.0.0.1:8888",
    "username": "scraper",
    "password": "PASSWORD",
})
```

### Any CLI tool

Most tools honour the standard proxy variables:

```sh
export HTTPS_PROXY=http://scraper:PASSWORD@127.0.0.1:8888 HTTP_PROXY=$HTTPS_PROXY
curl https://api.ipify.org
```

> [!WARNING]
> Node.js' built-in `fetch` ignores `HTTP(S)_PROXY` before Node 24 and silently
> goes direct. Use undici's `EnvHttpProxyAgent`, or verify your exit IP from the
> same runtime your scraper uses.

### Containers

A scraper that runs in Docker can skip the proxy and share the tunnel directly:

```yaml
services:
  scraper:
    image: my-scraper
    network_mode: "service:gluetun"
```

## Rotator API

All endpoints except `/health` need the header `X-API-Key: <ROTATOR_API_KEY>`
(or `Authorization: Bearer <key>`).

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | `{"status": "ok"}` |
| `GET` | `/ip` | Current exit IP with country, region, city, organization, timezone |
| `POST` | `/rotate` | `{"old_ip", "public_ip", "city", "country", "new_subnet", "attempts", ...}` |

`/rotate` takes roughly 5 to 40 seconds. Requests through the proxy fail while
the tunnel restarts, so pause or retry around it. A second rotate during a
rotation gets a `502`. If no server outside the old /24 is found within
`ROTATE_MAX_ATTEMPTS`, you still get the new IP with `"new_subnet": false`.

## Configuration

All settings live in `.env` (see [`.env.example`](.env.example)).

| Variable | Default | What it does |
|---|---|---|
| `WIREGUARD_PRIVATE_KEY` | | Proton WireGuard key (recommended) |
| `VPN_TYPE` | `wireguard` | Or `openvpn` with `OPENVPN_USER` / `OPENVPN_PASSWORD` |
| `SERVER_COUNTRIES` | `Netherlands` | Pool to rotate through. More countries, more IPs |
| `SERVER_CITIES` | | Narrow the pool further |
| `FREE_ONLY` | `off` | `on` for Proton Free accounts |
| `BIND_ADDR` | `127.0.0.1` | Set to a LAN IP to use the proxy from other devices |
| `PROXY_PORT` / `ROTATOR_PORT` | `8888` / `8081` | Host ports |
| `LAN_SUBNETS` | | e.g. `192.168.1.0/24`, lets tunnelled traffic reach your LAN |
| `ROTATE_REQUIRE_NEW_SUBNET` | `on` | Keep hopping until the /24 changes |
| `ROTATE_MAX_ATTEMPTS` | `6` | Reconnects per rotate call |
| `ROTATE_ATTEMPT_TIMEOUT` | `30` | Seconds to wait for a new IP per attempt |

`PROXY_PASSWORD`, `CONTROL_API_KEY` and `ROTATOR_API_KEY` are generated by
`setup.sh`. Re-running it keeps existing values.

## Claude Code skill

[`claude-skill/`](claude-skill) contains a [Claude Code](https://claude.com/claude-code)
skill so you can just say *"scrape this via the proxy"*. It starts the stack,
runs the work through the proxy, rotates when blocked, and **stops the stack
again afterwards**, with a 30-minute idle auto-stop as a safety net. Secrets are
injected into child processes and never printed.

```sh
cp -r claude-skill/skills/* ~/.claude/skills/
node ~/.claude/skills/tunnelhop/scripts/tunnelhop.mjs --help
```

```sh
tunnelhop.mjs up                       # start, wait for an exit IP, arm auto-stop
tunnelhop.mjs run -- python3 scrape.py # run with HTTP(S)_PROXY + rotator env injected
tunnelhop.mjs rotate                   # new IP
tunnelhop.mjs with -- curl -s https://api.ipify.org   # up, run, down in one go
tunnelhop.mjs down
```

## Security notes

- **Kill switch:** gluetun's firewall only allows traffic through the tunnel. If
  the VPN drops, proxied requests fail; they never leak via your own IP.
- **Authenticated everywhere:** the proxy needs a password, the rotator needs an
  API key, and gluetun's control API is locked to an API key that only allows
  the three routes the rotator needs.
- **Local by default:** ports bind to `127.0.0.1`. If you set `BIND_ADDR` to a LAN
  address, anyone who has the proxy password can use your VPN account.
- **No secrets in git:** `.env` and `gluetun/auth/config.toml` are git-ignored and
  created with mode `600`.
- **Pinned image:** gluetun is pinned to a version tag; update it deliberately.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `up` never gets an IP | `docker compose logs gluetun`. Usually a wrong or revoked WireGuard key; generate a new one. |
| Proxy returns `407` | Wrong proxy user/password. |
| Rotate is slow | The same server was picked again. Add countries to `SERVER_COUNTRIES` or lower `ROTATE_ATTEMPT_TIMEOUT`. |
| `new_subnet: false` | Your pool is too small. Widen `SERVER_COUNTRIES`. |
| Port already in use | Another service uses 8888/8081; change `PROXY_PORT` / `ROTATOR_PORT`. |

## Responsible use

tunnelhop is a tool for legitimate data collection, testing and privacy. Check
your VPN provider's terms of service, respect the `robots.txt`, terms and rate
limits of the sites you access, and follow the law where you and they are.
Rotating IPs to evade a ban you earned is on you.

## Credits

Built on [gluetun](https://github.com/qdm12/gluetun) by Quentin McGaw, which does
the heavy lifting. Not affiliated with or endorsed by Proton AG. ProtonVPN is a
trademark of Proton AG.

## License

[MIT](LICENSE)
