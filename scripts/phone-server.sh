#!/usr/bin/env bash
# Start MARI BASE from an Android/Termux checkout as a local evaluation server.
# The server binds to all interfaces so a browser or companion app can reach it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. In Termux run: pkg install -y nodejs-lts" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "MARI BASE requires Node.js 22 or newer; found $(node --version)." >&2
  echo "Install a current Termux Node package or use PRoot with Node 22." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing npm dependencies (first run only)…"
  npm ci
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-4100}"
export DATABASE_URL="${DATABASE_URL:-pglite://./data/postgres}"
export AUTO_MIGRATE="${AUTO_MIGRATE:-true}"
export STORAGE_DIR="${STORAGE_DIR:-./storage}"
export BACKUP_DIR="${BACKUP_DIR:-./data/backups}"

mkdir -p data storage data/backups

LAN_IP=""
if command -v ip >/dev/null 2>&1; then
  LAN_IP="$(ip -4 addr show wlan0 2>/dev/null | awk '/inet / { sub(/\/.*/, "", $2); print $2; exit }' || true)"
fi

echo
echo "  MARI BASE phone server"
echo "  ─────────────────────────────────────────────"
echo "  Runtime:      Node $(node --version)"
echo "  Bind:         ${HOST}:${PORT}"
echo "  Database:     ${DATABASE_URL}"
echo "  Studio:       http://127.0.0.1:${PORT}/"
echo "  Mobile page:  http://127.0.0.1:${PORT}/mobile/"
echo "  Public guide: http://127.0.0.1:${PORT}/guide/"
echo "  Readiness:    http://127.0.0.1:${PORT}/ready"
if [ -n "$LAN_IP" ]; then
  echo "  Trusted LAN:  http://${LAN_IP}:${PORT}  (from another device on the same Wi-Fi)"
else
  echo "  Trusted LAN:  run 'ip -4 addr show wlan0' to find this phone's Wi-Fi IP"
fi
echo
echo "  Keep this Termux session open. Use tmux and termux-wake-lock for longer sessions."
echo "  Development secrets from .env.example are not safe for internet exposure."
echo

exec npx tsx src/server.ts
