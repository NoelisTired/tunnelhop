#!/usr/bin/env sh
# Creates .env (if missing), fills empty secrets with random values and writes
# the gluetun control-server auth file. Safe to re-run: existing values are kept.
set -eu
cd "$(dirname "$0")"

[ -f .env ] || cp .env.example .env

get_var() {
  grep -E "^$1=" .env | head -n1 | cut -d= -f2-
}

fill_secret() {
  if [ -z "$(get_var "$1")" ]; then
    value=$(openssl rand -hex 24)
    awk -v k="$1" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' .env > .env.tmp
    mv .env.tmp .env
    echo "generated $1"
  fi
}

fill_secret PROXY_PASSWORD
fill_secret CONTROL_API_KEY
fill_secret ROTATOR_API_KEY
chmod 600 .env

mkdir -p gluetun/auth
cat > gluetun/auth/config.toml <<EOF
[[roles]]
name = "rotator"
routes = [
  "GET /v1/publicip/ip",
  "GET /v1/vpn/status",
  "PUT /v1/vpn/status",
]
auth = "apikey"
apikey = "$(get_var CONTROL_API_KEY)"
EOF
chmod 600 gluetun/auth/config.toml

if [ -z "$(get_var WIREGUARD_PRIVATE_KEY)" ] && [ -z "$(get_var OPENVPN_USER)" ]; then
  echo "Now fill in WIREGUARD_PRIVATE_KEY (or OpenVPN creds) in .env, then: docker compose up -d --build"
else
  echo "Ready: docker compose up -d --build"
fi
