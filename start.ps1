# Start codex-router-proxy in foreground mode (Ctrl+C to stop).
# Usage: .\start.ps1 [args passed through to main.mjs]
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js not found (>= 22.19 required). Install it from https://nodejs.org"
    exit 1
}

& node "$repo\src\proxy\main.mjs" @args
exit $LASTEXITCODE
