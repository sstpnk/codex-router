# start.sh — start codex-router-proxy (Ctrl+C to stop)
# Requires Node.js >= 22.19.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js not found (>= 22.19 required)." >&2
  exit 1
fi

exec node "$SCRIPT_DIR/src/proxy/main.mjs" "$@"
