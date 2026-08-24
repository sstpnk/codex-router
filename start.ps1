# Start codex-router-proxy in foreground mode (Ctrl+C to stop).
# Usage: .\start.ps1 [args passed through to main.mjs]
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js not found (>= 22.19 required). Install it from https://nodejs.org"
    exit 1
}

# Fail fast when router.toml was never created (step 1 of the Quick start).
# Mirrors the resolution order of src/proxy/paths.mjs.
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$stateDir = if ($env:MODEL_ROUTER_STATE_DIR) { $env:MODEL_ROUTER_STATE_DIR } else { Join-Path $codexHome "codex-router" }
$routerConfig = Join-Path $stateDir "router.toml"
if (-not (Test-Path -LiteralPath $routerConfig)) {
    Write-Host "router.toml not found at:" -ForegroundColor Red
    Write-Host "  $routerConfig"
    Write-Host ""
    Write-Host "Create it first (see 'Quick start' in README.md). Minimal example:"
    Write-Host ""
    Write-Host "  [primary]"
    Write-Host '  base_url = "https://your-endpoint/v1"'
    Write-Host '  model = "your-model"'
    Write-Host '  images = "off"'
    exit 1
}

& node "$repo\src\proxy\main.mjs" @args
exit $LASTEXITCODE
