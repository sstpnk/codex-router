# start.sh — start codex-router-proxy (Ctrl+C to stop)
# Requires Node.js >= 22.19.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js not found (>= 22.19 required)." >&2
  exit 1
fi

# Fail fast when router.toml was never created (step 1 of the Quick start).
# Mirrors the resolution order of src/proxy/paths.mjs.
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
STATE_DIR="${MODEL_ROUTER_STATE_DIR:-$CODEX_HOME/codex-router}"
ROUTER_CONFIG="$STATE_DIR/router.toml"

if [ ! -f "$ROUTER_CONFIG" ]; then
  echo "router.toml not found at: $ROUTER_CONFIG" >&2
  echo ""
  echo "Create it first (see 'Quick start' in README.md). Minimal example:"
  echo ""
  echo "  [primary]"
  echo '  base_url = "https://your-endpoint/v1"'
  echo '  model = "your-model"'
  echo '  images = "off"'
  exit 1
fi

exec node "$SCRIPT_DIR/src/proxy/main.mjs" "$@"
