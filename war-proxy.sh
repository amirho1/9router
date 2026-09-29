#!/usr/bin/env bash

set -Eeuo pipefail

# ============================================================
# Configuration
# ============================================================

# Cloudflare WARP's own localhost proxy.
WARP_PORT="${WARP_PORT:-40000}"

# Port exposed ONLY on Docker's internal bridge.
PROXY_PORT="${PROXY_PORT:-1080}"

SERVICE_NAME="warp-docker-proxy"

# ============================================================
# Root
# ============================================================

if [[ "${EUID}" -ne 0 ]]; then
    echo "Re-running with sudo..."
    exec sudo -E bash "$0" "$@"
fi

echo
echo "============================================================"
echo " Cloudflare WARP Docker-only proxy setup"
echo "============================================================"
echo

# ============================================================
# Check OS
# ============================================================

if [[ ! -f /etc/os-release ]]; then
    echo "ERROR: Cannot detect Linux distribution."
    exit 1
fi

. /etc/os-release

case "${ID}" in
    ubuntu|debian)
        ;;
    *)
        echo "ERROR: This script currently supports Ubuntu/Debian."
        echo "Detected: ${ID}"
        exit 1
        ;;
esac

# ============================================================
# Check Docker
# ============================================================

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: Docker is not installed."
    exit 1
fi

if ! systemctl is-active --quiet docker; then
    echo "Starting Docker..."
    systemctl start docker
fi

# ============================================================
# Find Docker bridge gateway
# ============================================================

DOCKER_GATEWAY="$(
    docker network inspect bridge \
        --format '{{(index .IPAM.Config 0).Gateway}}' \
        2>/dev/null || true
)"

if [[ -z "${DOCKER_GATEWAY}" ]]; then
    echo "ERROR: Could not determine Docker bridge gateway."
    exit 1
fi

echo "Docker host gateway: ${DOCKER_GATEWAY}"

# ============================================================
# Install dependencies
# ============================================================

echo
echo "Installing dependencies..."

apt-get update
apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    lsb-release \
    socat

# ============================================================
# Add Cloudflare repository
# ============================================================

echo
echo "Configuring Cloudflare package repository..."

install -d -m 0755 /usr/share/keyrings

curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
    | gpg --yes --dearmor \
    -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg

CODENAME="${VERSION_CODENAME:-}"

if [[ -z "${CODENAME}" ]]; then
    CODENAME="$(lsb_release -cs)"
fi

cat >/etc/apt/sources.list.d/cloudflare-client.list <<EOF
deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ ${CODENAME} main
EOF

apt-get update

echo
echo "Installing Cloudflare WARP..."

apt-get install -y cloudflare-warp

# ============================================================
# Start WARP daemon
# ============================================================

systemctl enable warp-svc
systemctl start warp-svc

echo "Waiting for WARP service..."

sleep 3

# ============================================================
# IMPORTANT:
# Disconnect first so an existing full-tunnel WARP setup cannot
# accidentally modify the server's normal routing.
# ============================================================

echo
echo "Ensuring WARP is NOT using full-tunnel mode..."

warp-cli --accept-tos disconnect >/dev/null 2>&1 || true

# ============================================================
# Register WARP
# ============================================================

echo
echo "Checking WARP registration..."

if ! warp-cli --accept-tos registration show >/dev/null 2>&1; then
    echo "Registering WARP client..."
    warp-cli --accept-tos registration new
else
    echo "WARP is already registered."
fi

# ============================================================
# Configure MASQUE
#
# Modern WARP proxy mode requires MASQUE.
# ============================================================

echo
echo "Configuring MASQUE..."

warp-cli --accept-tos tunnel protocol set MASQUE

# ============================================================
# Configure proxy-only mode
#
# THIS IS THE IMPORTANT PART.
#
# 'mode proxy' means WARP does NOT become the system default
# route. Only applications explicitly using the proxy are routed
# through WARP.
# ============================================================

echo
echo "Enabling WARP proxy-only mode..."

warp-cli --accept-tos mode proxy

echo "Setting local WARP port to ${WARP_PORT}..."

warp-cli --accept-tos proxy port "${WARP_PORT}"

# ============================================================
# Connect WARP
# ============================================================

echo
echo "Connecting WARP..."

warp-cli --accept-tos connect

sleep 4

# ============================================================
# Verify WARP
# ============================================================

echo
echo "Checking WARP status..."

warp-cli --accept-tos status || true

echo
echo "Testing WARP localhost proxy..."

TRACE="$(
    curl \
        --fail \
        --silent \
        --show-error \
        --max-time 20 \
        --proxy "socks5h://127.0.0.1:${WARP_PORT}" \
        https://www.cloudflare.com/cdn-cgi/trace
)"

if ! echo "${TRACE}" | grep -Eq '^warp=(on|plus)$'; then

    echo
    echo "ERROR: WARP proxy test failed."
    echo
    echo "${TRACE}"
    echo
    echo "WARP status:"
    warp-cli --accept-tos status || true

    exit 1
fi

echo "WARP localhost proxy works."

# ============================================================
# Create Docker-accessible relay
#
# WARP intentionally listens on localhost.
#
# socat exposes it ONLY on Docker's internal gateway:
#
# Docker containers
#      ↓
# 172.17.0.1:1080
#      ↓
# 127.0.0.1:40000
#      ↓
# WARP
#
# It does NOT bind to the server's public IP.
# ============================================================

echo
echo "Creating Docker-only proxy relay..."

systemctl stop "${SERVICE_NAME}.service" >/dev/null 2>&1 || true

# Make sure our requested Docker-side port isn't already occupied.
if ss -ltn | awk '{print $4}' | grep -qE ":${PROXY_PORT}$"; then

    echo
    echo "ERROR: Port ${PROXY_PORT} is already in use."
    echo
    echo "Choose another port:"
    echo
    echo "  PROXY_PORT=1081 sudo -E ./setup-warp-proxy.sh"
    exit 1
fi

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Expose Cloudflare WARP proxy to Docker containers
After=network-online.target docker.service warp-svc.service
Wants=network-online.target
Requires=docker.service warp-svc.service

[Service]
Type=simple

ExecStart=/usr/bin/socat \\
    TCP-LISTEN:${PROXY_PORT},bind=${DOCKER_GATEWAY},reuseaddr,fork \\
    TCP:127.0.0.1:${WARP_PORT}

Restart=always
RestartSec=3

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl start "${SERVICE_NAME}.service"

sleep 2

# ============================================================
# Verify relay
# ============================================================

echo
echo "Testing Docker-facing SOCKS5 proxy..."

PROXY_TRACE="$(
    curl \
        --fail \
        --silent \
        --show-error \
        --max-time 20 \
        --proxy "socks5h://${DOCKER_GATEWAY}:${PROXY_PORT}" \
        https://www.cloudflare.com/cdn-cgi/trace
)"

if ! echo "${PROXY_TRACE}" | grep -Eq '^warp=(on|plus)$'; then

    echo
    echo "ERROR: Docker-facing SOCKS proxy failed."
    echo
    echo "${PROXY_TRACE}"
    exit 1
fi

echo "SOCKS5 proxy works."

# ============================================================
# Test HTTP CONNECT
# ============================================================

echo
echo "Testing HTTP CONNECT proxy..."

HTTP_WORKS=false

if curl \
    --fail \
    --silent \
    --max-time 20 \
    --proxy "http://${DOCKER_GATEWAY}:${PROXY_PORT}" \
    https://www.cloudflare.com/cdn-cgi/trace \
    | grep -Eq '^warp=(on|plus)$'
then

    HTTP_WORKS=true

    echo "HTTP CONNECT proxy works."

else

    echo "HTTP CONNECT test failed."
    echo "SOCKS5 is still available."
fi

# ============================================================
# Verify normal OS traffic is NOT using WARP
# ============================================================

echo
echo "Checking normal server traffic..."

DIRECT_TRACE="$(
    curl \
        --silent \
        --max-time 20 \
        https://www.cloudflare.com/cdn-cgi/trace \
        || true
)"

DIRECT_WARP="$(
    echo "${DIRECT_TRACE}" \
        | grep '^warp=' \
        || true
)"

# ============================================================
# Finished
# ============================================================

echo
echo "============================================================"
echo " Installation complete"
echo "============================================================"
echo

echo "Normal OS traffic:"
echo "  ${DIRECT_WARP:-unable to determine}"
echo

echo "WARP internal proxy:"
echo
echo "  SOCKS5:"
echo "  socks5h://${DOCKER_GATEWAY}:${PROXY_PORT}"
echo

if [[ "${HTTP_WORKS}" == true ]]; then
    echo "  HTTP CONNECT:"
    echo "  http://${DOCKER_GATEWAY}:${PROXY_PORT}"
    echo
fi

echo "WARP localhost listener:"
echo "  127.0.0.1:${WARP_PORT}"
echo

echo "Docker gateway:"
echo "  ${DOCKER_GATEWAY}"
echo

echo "Service:"
echo "  ${SERVICE_NAME}.service"
echo

echo "Useful commands:"
echo
echo "  warp-cli status"
echo "  warp-cli settings"
echo "  systemctl status ${SERVICE_NAME}"
echo "  journalctl -u ${SERVICE_NAME} -f"
echo

echo "Test SOCKS:"
echo
echo "  curl --proxy socks5h://${DOCKER_GATEWAY}:${PROXY_PORT} \\"
echo "       https://www.cloudflare.com/cdn-cgi/trace"
echo

if [[ "${HTTP_WORKS}" == true ]]; then
    echo "Test HTTP proxy:"
    echo
    echo "  curl --proxy http://${DOCKER_GATEWAY}:${PROXY_PORT} \\"
    echo "       https://www.cloudflare.com/cdn-cgi/trace"
    echo
fi

echo "The proxy is bound ONLY to Docker's internal bridge address."
echo "It is NOT listening on your server's public IP."
echo